import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { HyperionWorkspace, type Checkpoint, type CheckpointId } from "../src/index.js";

const require = createRequire(import.meta.url);
const tempRoots: string[] = [];
const activeWorkspaces: HyperionWorkspace[] = [];

function getCommonJsFs(): typeof import("node:fs") {
  return require("node:fs") as typeof import("node:fs");
}

function createTempWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-vfs-"));
  tempRoots.push(root);
  return root;
}

function createWorkspace(root: string): HyperionWorkspace {
  const workspace = new HyperionWorkspace(root);
  activeWorkspaces.push(workspace);
  return workspace;
}

function getWorkspaceCheckpoint(
  workspace: HyperionWorkspace,
  checkpointId: CheckpointId,
): Checkpoint | undefined {
  return (
    workspace as unknown as {
      getCheckpoint(checkpointId: CheckpointId): Checkpoint | undefined;
    }
  ).getCheckpoint(checkpointId);
}

afterEach(async () => {
  while (activeWorkspaces.length > 0) {
    const workspace = activeWorkspaces.pop();
    await workspace?.dispose();
  }

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("VFS interceptor sync APIs", () => {
  it("auto-registers writeFileSync mutations as VFS dirty entries", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    fs.writeFileSync(path.join(root, "created.txt"), "created");

    const dirtyEntry = getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.get("created.txt");
    assert.equal(dirtyEntry?.capturedBy, "vfs");
    assert.equal(dirtyEntry?.kind, "created");
  });

  it("backs up modified files before patched writes so rollback restores original content", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    fs.writeFileSync(sourcePath, "mutated");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });

  it("backs up deleted files before unlinkSync and rmSync so rollback recreates them", async () => {
    const root = createTempWorkspace();
    const unlinkPath = path.join(root, "unlink.txt");
    const rmPath = path.join(root, "rm.txt");
    writeFileSync(unlinkPath, "unlink original");
    writeFileSync(rmPath, "rm original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    fs.unlinkSync(unlinkPath);
    fs.rmSync(rmPath);

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(unlinkPath, "utf8"), "unlink original");
    assert.equal(readFileSync(rmPath, "utf8"), "rm original");
  });

  it("removes files created through patched writeFileSync during rollback", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const createdPath = path.join(root, "created.txt");
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    fs.writeFileSync(createdPath, "created");

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(createdPath), false);
  });

  it("records appendFileSync, chmodSync, utimesSync, and mkdirSync mutations", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    fs.appendFileSync(sourcePath, "\nappended");
    fs.chmodSync(sourcePath, 0o666);
    fs.utimesSync(sourcePath, new Date(), new Date());
    fs.mkdirSync(path.join(root, "scratch"));

    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);
    assert.equal(checkpoint?.dirty.get("source.txt")?.capturedBy, "vfs");
    assert.equal(checkpoint?.dirty.get("scratch")?.capturedBy, "vfs");
    assert.equal(checkpoint?.dirty.get("scratch")?.fileType, "directory");
  });

  it("records renameSync source and destination and rolls both back", async () => {
    const root = createTempWorkspace();
    const oldPath = path.join(root, "old.txt");
    const newPath = path.join(root, "new.txt");
    writeFileSync(oldPath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    fs.renameSync(oldPath, newPath);

    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);
    assert.equal(checkpoint?.dirty.get("old.txt")?.capturedBy, "vfs");
    assert.equal(checkpoint?.dirty.get("new.txt")?.capturedBy, "vfs");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(oldPath, "utf8"), "original");
    assert.equal(existsSync(newPath), false);
  });

  it("records copyFileSync destination and removes it during rollback", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    const copyPath = path.join(root, "copy.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    fs.copyFileSync(sourcePath, copyPath);

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.get("copy.txt")?.capturedBy, "vfs");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
    assert.equal(existsSync(copyPath), false);
  });

  it("ignores configured ignored paths and outside-workspace paths", async () => {
    const root = createTempWorkspace();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "hyperion-vfs-outside-"));
    tempRoots.push(outsideRoot);
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "ignored");
    fs.writeFileSync(path.join(outsideRoot, "outside.txt"), "outside");

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.size, 0);
  });

  it("restores original fs functions on uninstall and remains idempotent", () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const fs = getCommonJsFs();
    const originalWriteFileSync = fs.writeFileSync;

    workspace.installFsInterceptor();
    const patchedWriteFileSync = fs.writeFileSync;
    workspace.installFsInterceptor();

    assert.notEqual(patchedWriteFileSync, originalWriteFileSync);
    assert.equal(fs.writeFileSync, patchedWriteFileSync);

    workspace.uninstallFsInterceptor();
    workspace.uninstallFsInterceptor();

    assert.equal(fs.writeFileSync, originalWriteFileSync);
    assert.equal(workspace.isFsInterceptorInstalled, false);
  });

  it("preserves original filesystem error behavior", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();

    assert.throws(
      () => fs.unlinkSync(path.join(root, "missing.txt")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});
