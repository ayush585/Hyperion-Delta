import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { DEFAULT_IGNORED_PATTERNS } from "../src/constants.js";
import {
  HybridStateEngine,
  diffStateManifests,
  parseGitIndexEntries,
} from "../src/internal/state.js";
import type { ResolvedHyperionConfig, StateManifest, StatLedgerEntry } from "../src/types.js";

const tempRoots: string[] = [];
const hasGit = commandAvailable("git");

function createTempWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-state-"));
  tempRoots.push(root);
  return root;
}

function createConfig(root: string): ResolvedHyperionConfig {
  return {
    workspaceRoot: root,
    useTmpfs: true,
    ignoredPatterns: [...DEFAULT_IGNORED_PATTERNS],
    overrideDefaultIgnores: false,
    enableFsInterceptor: true,
    maxConcurrentCheckpoints: 64,
    sessionRoot: path.join(root, ".hyperion", "checkpoints"),
    useHotBuffer: true,
    hotBufferMaxFileBytes: 256 * 1024,
    hotBufferMaxTotalBytes: 8 * 1024 * 1024,
    hotBufferMaxFiles: 1024,
    strictIgnoredWrites: false,
  };
}

function createEntry(
  relativePath: string,
  overrides: Partial<StatLedgerEntry> = {},
): StatLedgerEntry {
  return {
    relativePath,
    type: "file",
    size: 1,
    mtimeMs: 1,
    mode: 0o100644,
    ...overrides,
  };
}

function createManifest(entries: StatLedgerEntry[]): StateManifest {
  return {
    gitAvailable: false,
    gitIndexEntries: new Map(),
    statEntries: new Map(entries.map((entry) => [entry.relativePath, entry])),
    ignoredPatterns: [],
    capturedAt: 1,
  };
}

function commandAvailable(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("Git index baseline", () => {
  it("parses git ls-files --stage -z output with paths containing spaces", () => {
    const entries = parseGitIndexEntries(
      "100644 abcdef1234567890 0\tsrc/index.ts\0" +
        "100755 0123456789abcdef 2\tdocs/file with spaces.md\0",
    );

    assert.equal(entries.size, 2);
    assert.deepEqual(entries.get("src/index.ts"), {
      relativePath: "src/index.ts",
      mode: "100644",
      objectId: "abcdef1234567890",
      stage: 0,
    });
    assert.deepEqual(entries.get("docs/file with spaces.md"), {
      relativePath: "docs/file with spaces.md",
      mode: "100755",
      objectId: "0123456789abcdef",
      stage: 2,
    });
  });

  it("captures tracked files from a temp Git repository", { skip: !hasGit }, () => {
    const root = createTempWorkspace();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "tracked file.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "src/tracked file.ts"], { cwd: root, stdio: "ignore" });

    const engine = new HybridStateEngine(createConfig(root), { gitAvailableHint: true });
    const manifest = engine.captureManifest();

    assert.equal(manifest.gitAvailable, true);
    assert.equal(manifest.gitIndexEntries.has("src/tracked file.ts"), true);
  });

  it("falls back to stat-only mode when Git capture fails", () => {
    const root = createTempWorkspace();
    writeFileSync(path.join(root, "file.txt"), "content");

    const engine = new HybridStateEngine(createConfig(root), {
      gitAvailableHint: true,
      adapter: {
        readdirSync: (directoryPath) => [{ name: "file.txt", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }],
        lstatSync: () => ({
          size: 7,
          mtimeMs: 1,
          mode: 0o100644,
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        }),
        execFileSync: () => {
          throw new Error("git unavailable");
        },
        now: () => 1,
      },
    });

    const manifest = engine.captureManifest();

    assert.equal(manifest.gitAvailable, false);
    assert.equal(manifest.gitIndexEntries.size, 0);
    assert.equal(manifest.statEntries.has("file.txt"), true);
  });
});

describe("stat ledger", () => {
  it("captures a stat-only manifest without hashing file contents", () => {
    const root = createTempWorkspace();
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "index.ts"), "content");

    const engine = new HybridStateEngine(createConfig(root), { gitAvailableHint: false });
    const manifest = engine.captureManifest();

    assert.equal(manifest.gitAvailable, false);
    assert.equal(manifest.statEntries.get("src")?.type, "directory");
    assert.equal(manifest.statEntries.get("src/index.ts")?.type, "file");
    assert.equal(typeof manifest.statEntries.get("src/index.ts")?.mtimeMs, "number");
    assert.equal(typeof manifest.statEntries.get("src/index.ts")?.size, "number");
  });

  it("skips ignored directories and files", () => {
    const root = createTempWorkspace();
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(path.join(root, ".hyperion", "checkpoints"), { recursive: true });
    mkdirSync(path.join(root, "dist"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "ignored");
    writeFileSync(path.join(root, ".git", "config"), "ignored");
    writeFileSync(path.join(root, ".hyperion", "checkpoints", "manifest.json"), "ignored");
    writeFileSync(path.join(root, "dist", "bundle.js"), "ignored");
    writeFileSync(path.join(root, "src", "index.ts"), "tracked");

    const engine = new HybridStateEngine(createConfig(root), { gitAvailableHint: false });
    const manifest = engine.captureManifest();

    assert.equal(manifest.statEntries.has("node_modules"), false);
    assert.equal(manifest.statEntries.has(".git"), false);
    assert.equal(manifest.statEntries.has(".hyperion"), false);
    assert.equal(manifest.statEntries.has("dist"), false);
    assert.equal(manifest.statEntries.has("src/index.ts"), true);
  });

  it("classifies symlinks when the platform allows creating them", () => {
    const root = createTempWorkspace();
    writeFileSync(path.join(root, "target.txt"), "target");

    try {
      symlinkSync(path.join(root, "target.txt"), path.join(root, "target-link.txt"));
    } catch {
      return;
    }

    const engine = new HybridStateEngine(createConfig(root), { gitAvailableHint: false });
    const manifest = engine.captureManifest();

    assert.equal(manifest.statEntries.get("target-link.txt")?.type, "symlink");
  });
});

describe("manifest diffing", () => {
  it("classifies created, modified, deleted, and metadata changes", () => {
    const before = createManifest([
      createEntry("deleted.ts"),
      createEntry("modified.ts", { size: 1, mtimeMs: 1 }),
      createEntry("metadata.ts", { mode: 0o100644 }),
      createEntry("unchanged.ts"),
    ]);
    const after = createManifest([
      createEntry("created.ts"),
      createEntry("modified.ts", { size: 2, mtimeMs: 2 }),
      createEntry("metadata.ts", { mode: 0o100755 }),
      createEntry("unchanged.ts"),
    ]);

    const diff = diffStateManifests(before, after);

    assert.deepEqual(diff.created.map((entry) => entry.relativePath), ["created.ts"]);
    assert.deepEqual(diff.modified.map((entry) => entry.relativePath), ["modified.ts"]);
    assert.deepEqual(diff.deleted.map((entry) => entry.relativePath), ["deleted.ts"]);
    assert.deepEqual(diff.metadata.map((entry) => entry.relativePath), ["metadata.ts"]);
  });

  it("treats uncertain renames as delete plus create", () => {
    const before = createManifest([createEntry("old-name.ts")]);
    const after = createManifest([createEntry("new-name.ts")]);

    const diff = diffStateManifests(before, after);

    assert.deepEqual(diff.created.map((entry) => entry.relativePath), ["new-name.ts"]);
    assert.deepEqual(diff.deleted.map((entry) => entry.relativePath), ["old-name.ts"]);
  });
});
