import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { TmpfsDirtySetStrategy } from "../src/internal/tmpfs-dirty-set-strategy.js";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createStrategy(workspaceRoot: string, tmpfsRoot: string): TmpfsDirtySetStrategy {
  return new TmpfsDirtySetStrategy({
    workspaceRoot,
    tmpfsRoot,
    sessionId: "session-1",
    checkpointId: "checkpoint-1",
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("TmpfsDirtySetStrategy", () => {
  it("backs up regular files under the tmpfs namespace", () => {
    const workspaceRoot = createTempRoot("hyperion-tmpfs-workspace-");
    const tmpfsRoot = createTempRoot("hyperion-tmpfs-root-");
    const strategy = createStrategy(workspaceRoot, tmpfsRoot);
    writeFileSync(path.join(workspaceRoot, "source.txt"), "original");

    const record = strategy.backupFile("source.txt");

    assert.equal(record.kind, "file");
    assert.ok(record.backupPath);
    assert.equal(record.backupPath.startsWith(strategy.backupNamespace), true);
    assert.equal(readFileSync(record.backupPath, "utf8"), "original");
    assert.equal(
      record.backupPath,
      path.join(tmpfsRoot, "session-1", "checkpoint-1", "files", "source.txt"),
    );
  });

  it("stores missing-file tombstones without copying content", () => {
    const workspaceRoot = createTempRoot("hyperion-tmpfs-workspace-");
    const tmpfsRoot = createTempRoot("hyperion-tmpfs-root-");
    const strategy = createStrategy(workspaceRoot, tmpfsRoot);

    const record = strategy.backupFile("created-later.txt");

    assert.equal(record.kind, "missing");
    assert.equal(record.backupPath, undefined);
  });

  it("records directory metadata without copying a tree", () => {
    const workspaceRoot = createTempRoot("hyperion-tmpfs-workspace-");
    const tmpfsRoot = createTempRoot("hyperion-tmpfs-root-");
    const strategy = createStrategy(workspaceRoot, tmpfsRoot);
    mkdirSync(path.join(workspaceRoot, "src", "nested"), { recursive: true });
    writeFileSync(path.join(workspaceRoot, "src", "nested", "file.txt"), "content");

    const record = strategy.backupFile("src");

    assert.equal(record.kind, "directory");
    assert.equal(record.backupPath, undefined);
    assert.equal(existsSync(path.join(strategy.backupNamespace, "files", "src")), false);
  });

  it("restores modified and deleted files with Pure Manifest semantics", () => {
    const workspaceRoot = createTempRoot("hyperion-tmpfs-workspace-");
    const tmpfsRoot = createTempRoot("hyperion-tmpfs-root-");
    const strategy = createStrategy(workspaceRoot, tmpfsRoot);
    const sourcePath = path.join(workspaceRoot, "src", "source.txt");
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

  it("deletes only manifest-listed created paths", () => {
    const workspaceRoot = createTempRoot("hyperion-tmpfs-workspace-");
    const tmpfsRoot = createTempRoot("hyperion-tmpfs-root-");
    const strategy = createStrategy(workspaceRoot, tmpfsRoot);
    writeFileSync(path.join(workspaceRoot, "created.txt"), "created");
    writeFileSync(path.join(workspaceRoot, "unrelated.txt"), "safe");

    strategy.deleteCreatedPath("created.txt");

    assert.equal(existsSync(path.join(workspaceRoot, "created.txt")), false);
    assert.equal(readFileSync(path.join(workspaceRoot, "unrelated.txt"), "utf8"), "safe");
  });

  it("records and restores symlink metadata when the platform allows symlinks", () => {
    const workspaceRoot = createTempRoot("hyperion-tmpfs-workspace-");
    const tmpfsRoot = createTempRoot("hyperion-tmpfs-root-");
    const strategy = createStrategy(workspaceRoot, tmpfsRoot);
    writeFileSync(path.join(workspaceRoot, "target.txt"), "target");

    try {
      symlinkSync("target.txt", path.join(workspaceRoot, "target-link.txt"));
    } catch {
      return;
    }

    const record = strategy.backupFile("target-link.txt");
    rmSync(path.join(workspaceRoot, "target-link.txt"), { force: true });
    strategy.restoreFile("target-link.txt");

    assert.equal(record.kind, "symlink");
    assert.equal(readlinkSync(path.join(workspaceRoot, "target-link.txt")), "target.txt");
  });
});
