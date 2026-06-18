import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

import type {
  DirtyEntry,
  GitIndexEntry,
  ResolvedHyperionConfig,
  StateManifest,
  StatLedgerEntry,
} from "../types.js";
import { createIgnoreMatcher, type IgnoreMatcher } from "./ignore.js";
import { toPosixPath } from "./path.js";

export interface ManifestDiff {
  created: DirtyEntry[];
  modified: DirtyEntry[];
  deleted: DirtyEntry[];
  metadata: DirtyEntry[];
}

export interface StateEngineAdapter {
  readdirSync(path: string, options: { withFileTypes: true }): DirectoryEntryLike[];
  lstatSync(path: string): StatLike;
  execFileSync(command: string, args: readonly string[]): Buffer;
  now(): number;
}

export interface DirectoryEntryLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface StatLike {
  size: number;
  mtimeMs: number;
  mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

const nodeStateEngineAdapter: StateEngineAdapter = {
  readdirSync,
  lstatSync,
  execFileSync(command, args): Buffer {
    return execFileSync(command, [...args], { stdio: ["ignore", "pipe", "ignore"] });
  },
  now: () => Date.now(),
};

export class HybridStateEngine {
  private readonly workspaceRoot: string;
  private readonly ignoredPatterns: string[];
  private readonly ignoreMatcher: IgnoreMatcher;
  private readonly gitAvailableHint: boolean;
  private readonly adapter: StateEngineAdapter;

  public constructor(
    config: ResolvedHyperionConfig,
    options: {
      gitAvailableHint: boolean;
      adapter?: StateEngineAdapter;
    },
  ) {
    this.workspaceRoot = config.workspaceRoot;
    this.ignoredPatterns = [...config.ignoredPatterns];
    this.ignoreMatcher = createIgnoreMatcher(config.ignoredPatterns);
    this.gitAvailableHint = options.gitAvailableHint;
    this.adapter = options.adapter ?? nodeStateEngineAdapter;
  }

  public captureManifest(): StateManifest {
    const gitIndexEntries = this.captureGitIndexEntries();
    const statEntries = this.captureStatLedger();
    const capturedAt = this.adapter.now();

    const manifest: StateManifest = {
      gitAvailable: gitIndexEntries !== null,
      gitIndexEntries: gitIndexEntries ?? new Map(),
      statEntries,
      ignoredPatterns: [...this.ignoredPatterns],
      capturedAt,
    };
    const gitHead = manifest.gitAvailable ? this.captureGitHead() : undefined;

    if (gitHead) {
      manifest.gitHead = gitHead;
    }

    return manifest;
  }

  private captureGitIndexEntries(): Map<string, GitIndexEntry> | null {
    if (!this.gitAvailableHint) {
      return null;
    }

    try {
      const output = this.adapter.execFileSync("git", [
        "-C",
        this.workspaceRoot,
        "ls-files",
        "--stage",
        "-z",
      ]);
      return parseGitIndexEntries(output.toString("utf8"));
    } catch {
      return null;
    }
  }

  private captureGitHead(): string | undefined {
    try {
      const output = this.adapter.execFileSync("git", [
        "-C",
        this.workspaceRoot,
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
      const head = output.toString("utf8").trim();
      return head === "" ? undefined : head;
    } catch {
      return undefined;
    }
  }

  private captureStatLedger(): Map<string, StatLedgerEntry> {
    const statEntries = new Map<string, StatLedgerEntry>();
    this.walkDirectory(this.workspaceRoot, statEntries, false);
    return statEntries;
  }

  private walkDirectory(
    directoryPath: string,
    statEntries: Map<string, StatLedgerEntry>,
    treatMissingDirectoryAsRace: boolean,
  ): void {
    let entries: DirectoryEntryLike[];

    try {
      entries = this.adapter.readdirSync(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (treatMissingDirectoryAsRace && isTransientPathRaceError(error)) {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = toPosixPath(path.relative(this.workspaceRoot, absolutePath));

      if (this.ignoreMatcher.matches(relativePath)) {
        continue;
      }

      let stat: StatLike;

      try {
        stat = this.adapter.lstatSync(absolutePath);
      } catch (error) {
        if (isTransientPathRaceError(error)) {
          continue;
        }

        throw error;
      }

      statEntries.set(relativePath, createStatLedgerEntry(relativePath, stat));

      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        this.walkDirectory(absolutePath, statEntries, true);
      }
    }
  }
}

export function parseGitIndexEntries(output: string): Map<string, GitIndexEntry> {
  const entries = new Map<string, GitIndexEntry>();

  for (const rawEntry of output.split("\0")) {
    if (rawEntry === "") {
      continue;
    }

    const parsedEntry = parseGitIndexEntry(rawEntry);
    if (parsedEntry) {
      entries.set(parsedEntry.relativePath, parsedEntry);
    }
  }

  return entries;
}

export function diffStateManifests(before: StateManifest, after: StateManifest): ManifestDiff {
  const now = Date.now();
  const diff: ManifestDiff = {
    created: [],
    modified: [],
    deleted: [],
    metadata: [],
  };

  for (const [relativePath, afterEntry] of after.statEntries) {
    const beforeEntry = before.statEntries.get(relativePath);

    if (!beforeEntry) {
      diff.created.push(createDirtyEntry("created", relativePath, now, { after: afterEntry }));
      continue;
    }

    if (isModified(beforeEntry, afterEntry)) {
      diff.modified.push(
        createDirtyEntry("modified", relativePath, now, { before: beforeEntry, after: afterEntry }),
      );
      continue;
    }

    if (isMetadataChanged(beforeEntry, afterEntry)) {
      diff.metadata.push(
        createDirtyEntry("metadata", relativePath, now, { before: beforeEntry, after: afterEntry }),
      );
    }
  }

  for (const [relativePath, beforeEntry] of before.statEntries) {
    if (!after.statEntries.has(relativePath)) {
      diff.deleted.push(createDirtyEntry("deleted", relativePath, now, { before: beforeEntry }));
    }
  }

  return diff;
}

function parseGitIndexEntry(rawEntry: string): GitIndexEntry | null {
  const tabIndex = rawEntry.indexOf("\t");
  if (tabIndex === -1) {
    return null;
  }

  const metadata = rawEntry.slice(0, tabIndex);
  const relativePath = toPosixPath(rawEntry.slice(tabIndex + 1));
  const [mode, objectId, stageText] = metadata.split(" ");
  const stage = Number(stageText);

  if (!mode || !objectId || !Number.isInteger(stage)) {
    return null;
  }

  return {
    relativePath,
    mode,
    objectId,
    stage,
  };
}

function createStatLedgerEntry(relativePath: string, stat: StatLike): StatLedgerEntry {
  return {
    relativePath,
    type: statType(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
  };
}

function isTransientPathRaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  return code === "ENOENT" || code === "ENOTDIR";
}

function statType(stat: StatLike): StatLedgerEntry["type"] {
  if (stat.isSymbolicLink()) {
    return "symlink";
  }

  if (stat.isDirectory()) {
    return "directory";
  }

  return "file";
}

function isModified(before: StatLedgerEntry, after: StatLedgerEntry): boolean {
  return before.type !== after.type || before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function isMetadataChanged(before: StatLedgerEntry, after: StatLedgerEntry): boolean {
  return before.mode !== after.mode;
}

function createDirtyEntry(
  kind: DirtyEntry["kind"],
  relativePath: string,
  timestamp: number,
  entries: {
    before?: StatLedgerEntry;
    after?: StatLedgerEntry;
  },
): DirtyEntry {
  const dirtyEntry: DirtyEntry = {
    relativePath,
    kind,
    fileType: entries.after?.type ?? entries.before?.type ?? "unknown",
    capturedBy: "reconcile",
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  };

  if (entries.before) {
    dirtyEntry.before = entries.before;
  }

  if (entries.after) {
    dirtyEntry.after = entries.after;
  }

  return dirtyEntry;
}
