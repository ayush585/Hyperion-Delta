import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { HyperionWorkspace, type Checkpoint, type CheckpointId } from "../src/index.js";
import {
  discoverEnvironmentProfile,
  type EnvironmentProfile,
} from "../src/internal/environment.js";
import { PosixLinkStrategy } from "../src/internal/posix-link-strategy.js";
import { PureManifestStrategy } from "../src/internal/pure-manifest-strategy.js";
import { createCheckpointStorage } from "../src/internal/storage-factory.js";
import { TmpfsDirtySetStrategy } from "../src/internal/tmpfs-dirty-set-strategy.js";

const require = createRequire(import.meta.url);
const tempRoots: string[] = [];
const activeWorkspaces: HyperionWorkspace[] = [];
const gitAvailable = commandAvailable("git", ["--version"]);
const shellAvailable = process.platform === "win32"
  ? commandAvailable("cmd.exe", ["/d", "/s", "/c", "exit 0"])
  : commandAvailable("sh", ["-c", "exit 0"]);

function getCommonJsFs(): typeof import("node:fs") {
  return require("node:fs") as typeof import("node:fs");
}

function createTempWorkspace(prefix = "hyperion-integration-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createWorkspace(root: string, useTmpfs = false): HyperionWorkspace {
  const workspace = new HyperionWorkspace({ workspaceRoot: root, useTmpfs });
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

function commandAvailable(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runGit(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function runNodeMutation(root: string, script: string): void {
  execFileSync(process.execPath, ["-e", script], { cwd: root, stdio: "ignore" });
}

function runShellRedirection(root: string, fileName: string, content: string): void {
  if (process.platform === "win32") {
    execFileSync("cmd.exe", ["/d", "/s", "/c", `echo ${content}>${fileName}`], {
      cwd: root,
      stdio: "ignore",
    });
    return;
  }

  execFileSync("sh", ["-c", `printf '%s' ${JSON.stringify(content)} > ${fileName}`], {
    cwd: root,
    stdio: "ignore",
  });
}

async function writeStreamAndWait(
  stream: NodeJS.WritableStream,
  content: string,
): Promise<void> {
  stream.end(content);
  await once(stream, "finish");
}

function createStorageOptions(
  workspaceRoot: string,
  selectedKind: "tmpfs" | "posix-link" | "pure-manifest",
  tmpfsRoot?: string,
) {
  return {
    workspaceRoot,
    selectedKind,
    checkpointNamespace: path.join(workspaceRoot, ".hyperion", "checkpoints", "checkpoint-1"),
    checkpointId: "checkpoint-1",
    sessionId: "session-1",
    useHotBuffer: false,
    hotBufferMaxFileBytes: 256 * 1024,
    hotBufferMaxTotalBytes: 8 * 1024 * 1024,
    hotBufferMaxFiles: 1024,
    ...(tmpfsRoot ? { tmpfsRoot } : {}),
  };
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

describe("integration safety matrix", () => {
  it("rolls back real VFS create, modify, delete, rename, copy, and stream mutations", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const workspace = createWorkspace(root);
    const modifiedPath = path.join(root, "modified.txt");
    const deletedPath = path.join(root, "deleted.txt");
    const renamedPath = path.join(root, "renamed-source.txt");
    const copiedSourcePath = path.join(root, "copied-source.txt");
    const preexistingParent = path.join(root, "scratch-root");

    writeFileSync(modifiedPath, "original modified");
    writeFileSync(deletedPath, "original deleted");
    writeFileSync(renamedPath, "original renamed");
    writeFileSync(copiedSourcePath, "original copied");
    mkdirSync(preexistingParent, { recursive: true });
    const checkpointId = await workspace.snapshot();

    workspace.installFsInterceptor();
    fs.writeFileSync(path.join(root, "created.txt"), "created");
    fs.writeFileSync(modifiedPath, "mutated");
    fs.unlinkSync(deletedPath);
    fs.renameSync(renamedPath, path.join(root, "renamed-target.txt"));
    fs.copyFileSync(copiedSourcePath, path.join(root, "copied-target.txt"));
    fs.mkdirSync(path.join(preexistingParent, "agent", "nested"), { recursive: true });
    fs.writeFileSync(path.join(preexistingParent, "agent", "nested", "scratch.txt"), "scratch");
    await writeStreamAndWait(
      fs.createWriteStream(path.join(root, "stream-created.txt")),
      "stream",
    );

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(path.join(root, "created.txt")), false);
    assert.equal(existsSync(path.join(root, "stream-created.txt")), false);
    assert.equal(readFileSync(modifiedPath, "utf8"), "original modified");
    assert.equal(readFileSync(deletedPath, "utf8"), "original deleted");
    assert.equal(readFileSync(renamedPath, "utf8"), "original renamed");
    assert.equal(existsSync(path.join(root, "renamed-target.txt")), false);
    assert.equal(readFileSync(copiedSourcePath, "utf8"), "original copied");
    assert.equal(existsSync(path.join(root, "copied-target.txt")), false);
    assert.equal(existsSync(path.join(preexistingParent, "agent")), false);
    assert.equal(existsSync(preexistingParent), true);
  });

  it("removes abandoned Hyperion rollback temp files during workspace startup", () => {
    const root = createTempWorkspace();
    const sourceDir = path.join(root, "src");
    const ignoredDir = path.join(root, "node_modules", "pkg");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(ignoredDir, { recursive: true });
    writeFileSync(path.join(sourceDir, ".hyperion-source.tmp"), "temp");
    writeFileSync(path.join(sourceDir, ".hyperion-link-source.tmp"), "temp");
    writeFileSync(path.join(sourceDir, "ordinary.tmp"), "safe");
    writeFileSync(path.join(ignoredDir, ".hyperion-ignored.tmp"), "ignored-safe");

    const workspace = createWorkspace(root);

    assert.equal(existsSync(path.join(sourceDir, ".hyperion-source.tmp")), false);
    assert.equal(existsSync(path.join(sourceDir, ".hyperion-link-source.tmp")), false);
    assert.equal(readFileSync(path.join(sourceDir, "ordinary.tmp"), "utf8"), "safe");
    assert.equal(readFileSync(path.join(ignoredDir, ".hyperion-ignored.tmp"), "utf8"), "ignored-safe");
    assert.equal(workspace.root, path.resolve(root));
  });

  it("restores tracked Git files and preserves pre-existing untracked files", { skip: !gitAvailable }, async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const workspace = createWorkspace(root);
    const trackedPath = path.join(root, "tracked.txt");
    const untrackedPath = path.join(root, "untracked-before-snapshot.txt");

    runGit(root, ["init"]);
    writeFileSync(trackedPath, "tracked original");
    writeFileSync(untrackedPath, "pre-existing untracked");
    runGit(root, ["add", "tracked.txt"]);
    const checkpointId = await workspace.snapshot();
    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);

    workspace.installFsInterceptor();
    fs.writeFileSync(trackedPath, "tracked mutated");
    fs.writeFileSync(path.join(root, "created-after-snapshot.txt"), "created");

    await workspace.rollback(checkpointId);

    assert.equal(checkpoint?.baseline.gitAvailable, true);
    assert.equal(checkpoint?.baseline.gitIndexEntries.has("tracked.txt"), true);
    assert.equal(readFileSync(trackedPath, "utf8"), "tracked original");
    assert.equal(readFileSync(untrackedPath, "utf8"), "pre-existing untracked");
    assert.equal(existsSync(path.join(root, "created-after-snapshot.txt")), false);
  });

  it("does not track ignored Git, dependency, or Hyperion folders", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();

    workspace.installFsInterceptor();
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, ".hyperion", "scratch"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "ignored");
    fs.writeFileSync(path.join(root, ".git", "config"), "ignored");
    fs.writeFileSync(path.join(root, ".hyperion", "scratch", "file.txt"), "ignored");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(path.join(root, "node_modules", "pkg", "index.js"), "utf8"), "ignored");
    assert.equal(readFileSync(path.join(root, ".git", "config"), "utf8"), "ignored");
    assert.equal(readFileSync(path.join(root, ".hyperion", "scratch", "file.txt"), "utf8"), "ignored");
  });

  it("uses stat-only manifests outside Git while preserving rollback correctness", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const workspace = createWorkspace(root);
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "stat original");

    const checkpointId = await workspace.snapshot();
    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);
    workspace.installFsInterceptor();
    fs.writeFileSync(sourcePath, "stat mutated");

    await workspace.rollback(checkpointId);

    assert.equal(checkpoint?.baseline.gitAvailable, false);
    assert.equal(readFileSync(sourcePath, "utf8"), "stat original");
  });

  it("rolls back child-process-created files through mandatory reconcile", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();

    runNodeMutation(
      root,
      "const fs = require('node:fs'); fs.writeFileSync('child-created.txt', 'child');",
    );

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(path.join(root, "child-created.txt")), false);
  });

  it("detects child-process modified and deleted files while requiring backups for restore", async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    writeFileSync(path.join(root, "modified.txt"), "original modified");
    writeFileSync(path.join(root, "deleted.txt"), "original deleted");
    const checkpointId = await workspace.snapshot();

    runNodeMutation(
      root,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync('modified.txt', 'child mutated');",
        "fs.rmSync('deleted.txt', { force: true });",
      ].join("\n"),
    );
    const result = await workspace.reconcile(checkpointId);

    assert.equal(result.modified.includes("modified.txt"), true);
    assert.equal(result.deleted.includes("deleted.txt"), true);
    await assert.rejects(() => workspace.rollback(checkpointId), /Missing backup record/);
  });

  it("rolls back shell-redirection-created files through mandatory reconcile", { skip: !shellAvailable }, async () => {
    const root = createTempWorkspace();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();

    runShellRedirection(root, "shell-created.txt", "shell-created");

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(path.join(root, "shell-created.txt")), false);
  });

  it("keeps storage strategy safety fallbacks explicit", () => {
    const workspaceRoot = createTempWorkspace();
    const tmpfsFile = path.join(workspaceRoot, "not-a-directory");
    writeFileSync(tmpfsFile, "file");

    const tmpfsFallback = createCheckpointStorage(
      createStorageOptions(workspaceRoot, "tmpfs", tmpfsFile),
    );
    const pureManifest = createCheckpointStorage(
      createStorageOptions(workspaceRoot, "pure-manifest"),
    );
    const posixLink = createCheckpointStorage(createStorageOptions(workspaceRoot, "posix-link"));

    assert.equal(tmpfsFallback instanceof PureManifestStrategy, true);
    assert.equal(tmpfsFallback instanceof TmpfsDirtySetStrategy, false);
    assert.equal(pureManifest instanceof PureManifestStrategy, true);
    assert.equal(posixLink instanceof PosixLinkStrategy, true);
  });

  it("reports same-device link safety in environment discovery without mutating the workspace", () => {
    const root = createTempWorkspace();
    const sessionRoot = path.join(root, ".hyperion", "checkpoints");
    const profile: EnvironmentProfile = discoverEnvironmentProfile({
      workspaceRoot: root,
      sessionRoot,
    });

    assert.equal(typeof profile.sameDeviceForLinks, "boolean");
    assert.equal(existsSync(sessionRoot), false);
  });
});
