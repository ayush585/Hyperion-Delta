import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  NtfsLinkStrategy,
  type NtfsLinkStrategyAdapter,
} from "../src/internal/ntfs-link-strategy.js";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createStrategy(
  workspaceRoot: string,
  storageRoot: string,
  adapter?: NtfsLinkStrategyAdapter,
): NtfsLinkStrategy {
  return new NtfsLinkStrategy(
    workspaceRoot,
    path.join(storageRoot, ".hyperion", "checkpoints", "checkpoint-1"),
    adapter ? { adapter } : {},
  );
}

function createDelegatingAdapter(overrides: Partial<NtfsLinkStrategyAdapter> = {}) {
  const adapter: NtfsLinkStrategyAdapter = {
    linkSync,
    copyFileSync,
    renameSync,
    rmSync,
    mkdirSync,
    ...overrides,
  };
  return adapter;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("NtfsLinkStrategy", () => {
  it("backs up regular files through hard links and detaches the workspace target", () => {
    const workspaceRoot = createTempRoot("hyperion-ntfs-link-workspace-");
    const storageRoot = createTempRoot("hyperion-ntfs-link-storage-");
    const sourcePath = path.join(workspaceRoot, "source.txt");
    let linkCallCount = 0;
    writeFileSync(sourcePath, "original");
    const strategy = createStrategy(
      workspaceRoot,
      storageRoot,
      createDelegatingAdapter({
        linkSync(source, target) {
          linkCallCount += 1;
          linkSync(source, target);
        },
      }),
    );

    const record = strategy.backupFile("source.txt");
    writeFileSync(sourcePath, "mutated");

    assert.equal(linkCallCount, 1);
    assert.equal(record.kind, "file");
    assert.ok(record.backupPath);
    assert.equal(readFileSync(record.backupPath, "utf8"), "original");
    assert.equal(readFileSync(sourcePath, "utf8"), "mutated");
    assert.equal(strategy.isLinkModeActive, true);
    assert.equal(strategy.getDiagnostics().physicalStrategy, "ntfs-link");
    assert.equal(strategy.getDiagnostics().ntfsLink?.linkModeActive, true);
  });

  it("restores modified and deleted files with Pure Manifest semantics", () => {
    const workspaceRoot = createTempRoot("hyperion-ntfs-link-workspace-");
    const storageRoot = createTempRoot("hyperion-ntfs-link-storage-");
    const sourcePath = path.join(workspaceRoot, "src", "source.txt");
    const strategy = createStrategy(workspaceRoot, storageRoot);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "original");

    strategy.backupFile("src/source.txt");
    writeFileSync(sourcePath, "mutated");
    strategy.restoreFile("src/source.txt");
    assert.equal(readFileSync(sourcePath, "utf8"), "original");

    rmSync(sourcePath, { force: true });
    strategy.restoreFile("src/source.txt");
    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });

  it("deletes only manifest-listed created files", () => {
    const workspaceRoot = createTempRoot("hyperion-ntfs-link-workspace-");
    const storageRoot = createTempRoot("hyperion-ntfs-link-storage-");
    const strategy = createStrategy(workspaceRoot, storageRoot);
    writeFileSync(path.join(workspaceRoot, "created.txt"), "created");
    writeFileSync(path.join(workspaceRoot, "unrelated.txt"), "safe");

    strategy.deleteCreatedPath("created.txt");

    assert.equal(existsSync(path.join(workspaceRoot, "created.txt")), false);
    assert.equal(readFileSync(path.join(workspaceRoot, "unrelated.txt"), "utf8"), "safe");
  });

  it("matches Pure Manifest records for missing paths, directories, and symlinks", () => {
    const workspaceRoot = createTempRoot("hyperion-ntfs-link-workspace-");
    const storageRoot = createTempRoot("hyperion-ntfs-link-storage-");
    const strategy = createStrategy(workspaceRoot, storageRoot);
    mkdirSync(path.join(workspaceRoot, "dir"), { recursive: true });
    writeFileSync(path.join(workspaceRoot, "target.txt"), "target");

    const missingRecord = strategy.backupFile("missing.txt");
    const directoryRecord = strategy.backupFile("dir");

    assert.equal(missingRecord.kind, "missing");
    assert.equal(directoryRecord.kind, "directory");

    try {
      symlinkSync("target.txt", path.join(workspaceRoot, "target-link.txt"));
    } catch {
      return;
    }

    const symlinkRecord = strategy.backupFile("target-link.txt");
    rmSync(path.join(workspaceRoot, "target-link.txt"), { force: true });
    strategy.restoreFile("target-link.txt");

    assert.equal(symlinkRecord.kind, "symlink");
    assert.equal(readlinkSync(path.join(workspaceRoot, "target-link.txt")), "target.txt");
  });

  it("falls back to copy semantics when hard-link setup fails", () => {
    const workspaceRoot = createTempRoot("hyperion-ntfs-link-workspace-");
    const storageRoot = createTempRoot("hyperion-ntfs-link-storage-");
    const sourcePath = path.join(workspaceRoot, "source.txt");
    const strategy = createStrategy(
      workspaceRoot,
      storageRoot,
      createDelegatingAdapter({
        linkSync() {
          const error = new Error("hard links unavailable");
          (error as NodeJS.ErrnoException).code = "EPERM";
          throw error;
        },
      }),
    );
    writeFileSync(sourcePath, "original");

    const record = strategy.backupFile("source.txt");
    writeFileSync(sourcePath, "mutated");
    strategy.restoreFile("source.txt");

    assert.equal(strategy.isLinkModeActive, false);
    assert.equal(record.kind, "file");
    assert.ok(record.backupPath);
    assert.equal(readFileSync(record.backupPath, "utf8"), "original");
    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });
});
