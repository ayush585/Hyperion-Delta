import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { HyperionIntegrityError } from "../errors.js";
import type { DirtyEntry } from "../types.js";
import type { StoredCheckpoint } from "./checkpoint-store.js";
import type { StorageStrategy } from "./storage-strategy.js";

export interface PatchExportOptions {
  workspaceRoot: string;
  checkpoint: StoredCheckpoint;
  storage: StorageStrategy;
}

export class PatchExportEngine {
  public exportPatch(options: PatchExportOptions): string {
    const entries = [...options.checkpoint.dirty.values()]
      .filter((entry) => isPatchableDirtyKind(entry.kind))
      .sort((first, second) => first.relativePath.localeCompare(second.relativePath));

    const patches: string[] = [];

    for (const entry of entries) {
      const patch = this.exportEntry(options, entry);

      if (patch) {
        patches.push(patch);
      }
    }

    return patches.join("");
  }

  private exportEntry(options: PatchExportOptions, entry: DirtyEntry): string {
    if (entry.fileType === "directory" || entry.kind === "metadata") {
      return "";
    }

    if (entry.fileType === "symlink") {
      throw new HyperionIntegrityError(`Patch export does not support symlink changes: ${entry.relativePath}`);
    }

    if (entry.kind === "created") {
      const after = this.readCurrentRegularFile(options.workspaceRoot, entry.relativePath);
      return createFilePatch(entry.relativePath, undefined, after);
    }

    const before = options.storage.readBackupFile(entry.relativePath);

    if (!before) {
      throw new HyperionIntegrityError(`Missing backup content for patch export: ${entry.relativePath}`);
    }

    if (entry.kind === "deleted") {
      return createFilePatch(entry.relativePath, before, undefined);
    }

    const after = this.readCurrentRegularFile(options.workspaceRoot, entry.relativePath);
    return createFilePatch(entry.relativePath, before, after);
  }

  private readCurrentRegularFile(workspaceRoot: string, relativePath: string): Buffer {
    const filePath = path.join(workspaceRoot, ...relativePath.split("/"));

    if (!existsSync(filePath)) {
      throw new HyperionIntegrityError(`Missing current file for patch export: ${relativePath}`);
    }

    const stat = lstatSync(filePath);

    if (stat.isSymbolicLink()) {
      throw new HyperionIntegrityError(`Patch export does not support symlink changes: ${relativePath}`);
    }

    if (!stat.isFile()) {
      throw new HyperionIntegrityError(`Patch export only supports regular files: ${relativePath}`);
    }

    return readFileSync(filePath);
  }
}

function createFilePatch(
  relativePath: string,
  before: Buffer | undefined,
  after: Buffer | undefined,
): string {
  assertTextPatchable(relativePath, before, after);

  const oldLines = before ? splitPatchLines(before) : emptyPatchLines();
  const newLines = after ? splitPatchLines(after) : emptyPatchLines();
  const oldPath = before ? `a/${relativePath}` : "/dev/null";
  const newPath = after ? `b/${relativePath}` : "/dev/null";
  const oldRange = before ? formatRange(1, oldLines.lines.length) : "0,0";
  const newRange = after ? formatRange(1, newLines.lines.length) : "0,0";
  const patchLines = [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -${oldRange} +${newRange} @@`,
  ];

  for (const line of oldLines.lines) {
    patchLines.push(`-${line}`);
  }

  if (before && !oldLines.endsWithNewline) {
    patchLines.push("\\ No newline at end of file");
  }

  for (const line of newLines.lines) {
    patchLines.push(`+${line}`);
  }

  if (after && !newLines.endsWithNewline) {
    patchLines.push("\\ No newline at end of file");
  }

  return `${patchLines.join("\n")}\n`;
}

function isPatchableDirtyKind(kind: DirtyEntry["kind"]): boolean {
  return kind === "created" || kind === "modified" || kind === "deleted";
}

function assertTextPatchable(
  relativePath: string,
  before: Buffer | undefined,
  after: Buffer | undefined,
): void {
  for (const candidate of [before, after]) {
    if (candidate && candidate.includes(0)) {
      throw new HyperionIntegrityError(`Patch export does not support binary files: ${relativePath}`);
    }
  }
}

function splitPatchLines(buffer: Buffer): { lines: string[]; endsWithNewline: boolean } {
  const text = buffer.toString("utf8");
  const endsWithNewline = text.endsWith("\n");
  const normalized = endsWithNewline ? text.slice(0, -1) : text;

  if (normalized === "") {
    return { lines: [], endsWithNewline };
  }

  return {
    lines: normalized.split("\n"),
    endsWithNewline,
  };
}

function emptyPatchLines(): { lines: string[]; endsWithNewline: boolean } {
  return { lines: [], endsWithNewline: true };
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}
