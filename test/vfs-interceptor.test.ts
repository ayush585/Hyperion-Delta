import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import {
  HyperionIgnoredPathError,
  HyperionWorkspace,
  type Checkpoint,
  type CheckpointId,
  type HyperionConfig,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const tempRoots: string[] = [];
const activeWorkspaces: HyperionWorkspace[] = [];

function getCommonJsFs(): typeof import("node:fs") {
  return require("node:fs") as typeof import("node:fs");
}

function getCommonJsFsPromises(): typeof import("node:fs/promises") {
  return require("node:fs/promises") as typeof import("node:fs/promises");
}

function createTempWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-vfs-"));
  tempRoots.push(root);
  return root;
}

function createWorkspace(
  root: string,
  config: Partial<Omit<HyperionConfig, "workspaceRoot">> = {},
): HyperionWorkspace {
  const workspace = new HyperionWorkspace({ workspaceRoot: root, ...config });
  activeWorkspaces.push(workspace);
  return workspace;
}

function getIgnoredWriteEvents(workspace: HyperionWorkspace): Array<{
  relativePath: string;
  kind: string;
  capturedAt: number;
}> {
  return [
    ...(
      workspace as unknown as {
        ignoredWriteEvents: Array<{
          relativePath: string;
          kind: string;
          capturedAt: number;
        }>;
      }
    ).ignoredWriteEvents,
  ];
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

function waitForCallback(
  register: (callback: (error: NodeJS.ErrnoException | null) => void) => void,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    register((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }

      resolvePromise();
    });
  });
}

function captureCallbackError(
  register: (callback: (error: NodeJS.ErrnoException | null) => void) => void,
): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolvePromise) => {
    register((error) => {
      resolvePromise(error);
    });
  });
}

async function writeStreamAndWait(
  stream: NodeJS.WritableStream,
  content: string,
): Promise<void> {
  stream.end(content);
  await once(stream, "finish");
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
    assert.deepEqual(
      getIgnoredWriteEvents(workspace).map((event) => event.relativePath),
      ["node_modules/pkg", "node_modules/pkg/index.js"],
    );
  });

  it("blocks ignored writeFileSync mutations in strict mode before writing", async () => {
    const root = createTempWorkspace();
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(path.join(root, ".hyperion", "scratch"), { recursive: true });
    mkdirSync(path.join(root, "dist"), { recursive: true });
    const workspace = createWorkspace(root, { strictIgnoredWrites: true });
    await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();

    for (const relativePath of [
      path.join("node_modules", "pkg", "index.js"),
      path.join(".git", "config"),
      path.join(".hyperion", "scratch", "file.txt"),
      path.join("dist", "output.js"),
    ]) {
      const targetPath = path.join(root, relativePath);
      assert.throws(
        () => fs.writeFileSync(targetPath, "blocked"),
        HyperionIgnoredPathError,
      );
      assert.equal(existsSync(targetPath), false);
    }

    assert.deepEqual(
      getIgnoredWriteEvents(workspace).map((event) => event.relativePath),
      [
        "node_modules/pkg/index.js",
        ".git/config",
        ".hyperion/scratch/file.txt",
        "dist/output.js",
      ],
    );
  });

  it("allows outside-workspace writes in strict ignored-write mode", async () => {
    const root = createTempWorkspace();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "hyperion-vfs-outside-"));
    tempRoots.push(outsideRoot);
    const workspace = createWorkspace(root, { strictIgnoredWrites: true });
    await workspace.snapshot();
    const fs = getCommonJsFs();
    const outsidePath = path.join(outsideRoot, "outside.txt");

    workspace.installFsInterceptor();
    fs.writeFileSync(outsidePath, "outside");

    assert.equal(readFileSync(outsidePath, "utf8"), "outside");
    assert.equal(getIgnoredWriteEvents(workspace).length, 0);
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

describe("VFS interceptor callback APIs", () => {
  it("auto-registers writeFile callback mutations as VFS dirty entries", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await waitForCallback((callback) => fs.writeFile(path.join(root, "created.txt"), "created", callback));

    const dirtyEntry = getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.get("created.txt");
    assert.equal(dirtyEntry?.capturedBy, "vfs");
    assert.equal(dirtyEntry?.kind, "created");
  });

  it("backs up modified files before callback writes so rollback restores original content", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await waitForCallback((callback) => fs.writeFile(sourcePath, "mutated", callback));

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });

  it("backs up deleted files before callback unlink and rm so rollback recreates them", async () => {
    const root = createTempWorkspace();
    const unlinkPath = path.join(root, "unlink.txt");
    const rmPath = path.join(root, "rm.txt");
    writeFileSync(unlinkPath, "unlink original");
    writeFileSync(rmPath, "rm original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await waitForCallback((callback) => fs.unlink(unlinkPath, callback));
    await waitForCallback((callback) => fs.rm(rmPath, callback));

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(unlinkPath, "utf8"), "unlink original");
    assert.equal(readFileSync(rmPath, "utf8"), "rm original");
  });

  it("removes files created through callback writeFile during rollback", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const createdPath = path.join(root, "created.txt");
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await waitForCallback((callback) => fs.writeFile(createdPath, "created", callback));

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(createdPath), false);
  });

  it("records appendFile, chmod, utimes, and mkdir callback mutations", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await waitForCallback((callback) => fs.appendFile(sourcePath, "\nappended", callback));
    await waitForCallback((callback) => fs.chmod(sourcePath, 0o666, callback));
    await waitForCallback((callback) => fs.utimes(sourcePath, new Date(), new Date(), callback));
    await waitForCallback((callback) => fs.mkdir(path.join(root, "scratch"), callback));

    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);
    assert.equal(checkpoint?.dirty.get("source.txt")?.capturedBy, "vfs");
    assert.equal(checkpoint?.dirty.get("scratch")?.capturedBy, "vfs");
    assert.equal(checkpoint?.dirty.get("scratch")?.fileType, "directory");
  });

  it("records callback rename source and destination and rolls both back", async () => {
    const root = createTempWorkspace();
    const oldPath = path.join(root, "old.txt");
    const newPath = path.join(root, "new.txt");
    writeFileSync(oldPath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await waitForCallback((callback) => fs.rename(oldPath, newPath, callback));

    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);
    assert.equal(checkpoint?.dirty.get("old.txt")?.capturedBy, "vfs");
    assert.equal(checkpoint?.dirty.get("new.txt")?.capturedBy, "vfs");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(oldPath, "utf8"), "original");
    assert.equal(existsSync(newPath), false);
  });

  it("records callback copyFile destination and removes it during rollback", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    const copyPath = path.join(root, "copy.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await waitForCallback((callback) => fs.copyFile(sourcePath, copyPath, callback));

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.get("copy.txt")?.capturedBy, "vfs");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
    assert.equal(existsSync(copyPath), false);
  });

  it("ignores configured ignored paths and outside-workspace callback writes", async () => {
    const root = createTempWorkspace();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "hyperion-vfs-outside-"));
    tempRoots.push(outsideRoot);
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await waitForCallback((callback) => fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true }, callback));
    await waitForCallback((callback) => fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "ignored", callback));
    await waitForCallback((callback) => fs.writeFile(path.join(outsideRoot, "outside.txt"), "outside", callback));

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.size, 0);
    assert.deepEqual(
      getIgnoredWriteEvents(workspace).map((event) => event.relativePath),
      ["node_modules/pkg", "node_modules/pkg/index.js"],
    );
  });

  it("blocks ignored callback writes in strict mode before writing", async () => {
    const root = createTempWorkspace();
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    const workspace = createWorkspace(root, { strictIgnoredWrites: true });
    await workspace.snapshot();
    const fs = getCommonJsFs();
    const targetPath = path.join(root, "node_modules", "pkg", "index.js");

    workspace.installFsInterceptor();

    assert.throws(
      () => fs.writeFile(targetPath, "blocked", () => undefined),
      HyperionIgnoredPathError,
    );
    assert.equal(existsSync(targetPath), false);
  });

  it("preserves callback error behavior from the original function", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    const error = await captureCallbackError((callback) => fs.unlink(path.join(root, "missing.txt"), callback));

    assert.equal(error?.code, "ENOENT");
  });

  it("does not record dirty entries when callback arguments are invalid", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();
    const invalidWriteFile = fs.writeFile as unknown as (...args: unknown[]) => unknown;

    workspace.installFsInterceptor();

    assert.throws(() => invalidWriteFile(path.join(root, "invalid.txt"), "data"), TypeError);
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.size, 0);
  });
});

describe("VFS interceptor fs/promises APIs", () => {
  it("auto-registers promise writeFile mutations as VFS dirty entries", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fsPromises = getCommonJsFsPromises();

    workspace.installFsInterceptor();
    await fsPromises.writeFile(path.join(root, "created.txt"), "created");

    const dirtyEntry = getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.get("created.txt");
    assert.equal(dirtyEntry?.capturedBy, "vfs");
    assert.equal(dirtyEntry?.kind, "created");
  });

  it("backs up modified files before promise writes so rollback restores original content", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fsPromises = getCommonJsFsPromises();

    workspace.installFsInterceptor();
    await fsPromises.writeFile(sourcePath, "mutated");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });

  it("backs up deleted files before promise unlink and rm so rollback recreates them", async () => {
    const root = createTempWorkspace();
    const unlinkPath = path.join(root, "unlink.txt");
    const rmPath = path.join(root, "rm.txt");
    writeFileSync(unlinkPath, "unlink original");
    writeFileSync(rmPath, "rm original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fsPromises = getCommonJsFsPromises();

    workspace.installFsInterceptor();
    await fsPromises.unlink(unlinkPath);
    await fsPromises.rm(rmPath);

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(unlinkPath, "utf8"), "unlink original");
    assert.equal(readFileSync(rmPath, "utf8"), "rm original");
  });

  it("removes files created through promise writeFile during rollback", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const createdPath = path.join(root, "created.txt");
    const fsPromises = getCommonJsFsPromises();

    workspace.installFsInterceptor();
    await fsPromises.writeFile(createdPath, "created");

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(createdPath), false);
  });

  it("records appendFile, chmod, utimes, and mkdir promise mutations", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fsPromises = getCommonJsFsPromises();

    workspace.installFsInterceptor();
    await fsPromises.appendFile(sourcePath, "\nappended");
    await fsPromises.chmod(sourcePath, 0o666);
    await fsPromises.utimes(sourcePath, new Date(), new Date());
    await fsPromises.mkdir(path.join(root, "scratch"));

    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);
    assert.equal(checkpoint?.dirty.get("source.txt")?.capturedBy, "vfs");
    assert.equal(checkpoint?.dirty.get("scratch")?.capturedBy, "vfs");
    assert.equal(checkpoint?.dirty.get("scratch")?.fileType, "directory");
  });

  it("records promise rename source and destination and rolls both back", async () => {
    const root = createTempWorkspace();
    const oldPath = path.join(root, "old.txt");
    const newPath = path.join(root, "new.txt");
    writeFileSync(oldPath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fsPromises = getCommonJsFsPromises();

    workspace.installFsInterceptor();
    await fsPromises.rename(oldPath, newPath);

    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);
    assert.equal(checkpoint?.dirty.get("old.txt")?.capturedBy, "vfs");
    assert.equal(checkpoint?.dirty.get("new.txt")?.capturedBy, "vfs");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(oldPath, "utf8"), "original");
    assert.equal(existsSync(newPath), false);
  });

  it("records promise copyFile destination and removes it during rollback", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    const copyPath = path.join(root, "copy.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fsPromises = getCommonJsFsPromises();

    workspace.installFsInterceptor();
    await fsPromises.copyFile(sourcePath, copyPath);

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.get("copy.txt")?.capturedBy, "vfs");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
    assert.equal(existsSync(copyPath), false);
  });

  it("ignores configured ignored paths and outside-workspace promise writes", async () => {
    const root = createTempWorkspace();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "hyperion-vfs-outside-"));
    tempRoots.push(outsideRoot);
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fsPromises = getCommonJsFsPromises();

    workspace.installFsInterceptor();
    await fsPromises.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fsPromises.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "ignored");
    await fsPromises.writeFile(path.join(outsideRoot, "outside.txt"), "outside");

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.size, 0);
    assert.deepEqual(
      getIgnoredWriteEvents(workspace).map((event) => event.relativePath),
      ["node_modules/pkg", "node_modules/pkg/index.js"],
    );
  });

  it("blocks ignored promise writes in strict mode before writing", async () => {
    const root = createTempWorkspace();
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    const workspace = createWorkspace(root, { strictIgnoredWrites: true });
    await workspace.snapshot();
    const fsPromises = getCommonJsFsPromises();
    const targetPath = path.join(root, "node_modules", "pkg", "index.js");

    workspace.installFsInterceptor();

    await assert.rejects(
      async () => {
        await fsPromises.writeFile(targetPath, "blocked");
      },
      HyperionIgnoredPathError,
    );
    assert.equal(existsSync(targetPath), false);
  });

  it("preserves promise rejection behavior from the original function", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    await workspace.snapshot();
    const fsPromises = getCommonJsFsPromises();

    workspace.installFsInterceptor();

    await assert.rejects(
      () => fsPromises.unlink(path.join(root, "missing.txt")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  });

  it("restores fs.promises and node:fs/promises functions on uninstall", () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const fs = getCommonJsFs();
    const fsPromises = getCommonJsFsPromises();
    const originalFsPromisesWriteFile = fs.promises.writeFile;
    const originalNodeFsPromisesWriteFile = fsPromises.writeFile;

    workspace.installFsInterceptor();

    assert.notEqual(fs.promises.writeFile, originalFsPromisesWriteFile);
    assert.notEqual(fsPromises.writeFile, originalNodeFsPromisesWriteFile);

    workspace.uninstallFsInterceptor();

    assert.equal(fs.promises.writeFile, originalFsPromisesWriteFile);
    assert.equal(fsPromises.writeFile, originalNodeFsPromisesWriteFile);
  });
});

describe("VFS interceptor write streams", () => {
  it("auto-registers createWriteStream targets as VFS dirty entries", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();
    const createdPath = path.join(root, "stream-created.txt");

    workspace.installFsInterceptor();
    await writeStreamAndWait(fs.createWriteStream(createdPath), "created");

    const dirtyEntry = getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.get("stream-created.txt");
    assert.equal(dirtyEntry?.capturedBy, "vfs");
    assert.equal(dirtyEntry?.kind, "created");
  });

  it("removes files created through createWriteStream during rollback", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();
    const createdPath = path.join(root, "stream-created.txt");

    workspace.installFsInterceptor();
    await writeStreamAndWait(fs.createWriteStream(createdPath), "created");

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(createdPath), false);
  });

  it("backs up modified stream targets before creation so rollback restores original content", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await writeStreamAndWait(fs.createWriteStream(sourcePath), "mutated");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });

  it("backs up append-mode stream targets before append so rollback restores original content", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    await writeStreamAndWait(fs.createWriteStream(sourcePath, { flags: "a" }), "\nappended");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });

  it("ignores configured ignored paths and outside-workspace stream targets", async () => {
    const root = createTempWorkspace();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "hyperion-vfs-outside-"));
    tempRoots.push(outsideRoot);
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeStreamAndWait(
      fs.createWriteStream(path.join(root, "node_modules", "pkg", "index.js")),
      "ignored",
    );
    await writeStreamAndWait(fs.createWriteStream(path.join(outsideRoot, "outside.txt")), "outside");

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.size, 0);
    assert.deepEqual(
      getIgnoredWriteEvents(workspace).map((event) => event.relativePath),
      ["node_modules/pkg/index.js"],
    );
  });

  it("blocks ignored createWriteStream targets in strict mode before writing", async () => {
    const root = createTempWorkspace();
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    const workspace = createWorkspace(root, { strictIgnoredWrites: true });
    await workspace.snapshot();
    const fs = getCommonJsFs();
    const targetPath = path.join(root, "node_modules", "pkg", "index.js");

    workspace.installFsInterceptor();

    assert.throws(
      () => fs.createWriteStream(targetPath),
      HyperionIgnoredPathError,
    );
    assert.equal(existsSync(targetPath), false);
  });

  it("preserves createWriteStream error emission for missing parent directories", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    await workspace.snapshot();
    const fs = getCommonJsFs();

    workspace.installFsInterceptor();
    const stream = fs.createWriteStream(path.join(root, "missing-parent", "file.txt"));
    stream.end("content");
    const [error] = await once(stream, "error");

    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  });

  it("ignores numeric createWriteStream targets", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const fs = getCommonJsFs();
    const invalidCreateWriteStream = fs.createWriteStream as unknown as (...args: unknown[]) => unknown;

    workspace.installFsInterceptor();

    assert.throws(() => invalidCreateWriteStream(1), TypeError);
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.size, 0);
  });

  it("restores original createWriteStream on uninstall", () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const fs = getCommonJsFs();
    const originalCreateWriteStream = fs.createWriteStream;

    workspace.installFsInterceptor();

    assert.notEqual(fs.createWriteStream, originalCreateWriteStream);

    workspace.uninstallFsInterceptor();

    assert.equal(fs.createWriteStream, originalCreateWriteStream);
  });
});
