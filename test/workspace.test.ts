import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  DEFAULT_HOT_BUFFER_MAX_FILE_BYTES,
  DEFAULT_HOT_BUFFER_MAX_FILES,
  DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES,
  DEFAULT_IGNORED_PATTERNS,
  HyperionCapacityError,
  HyperionError,
  HyperionIgnoredPathError,
  HyperionIntegrityError,
  HyperionPathError,
  HyperionRollbackError,
  HyperionWorkspace,
  type Checkpoint,
  type CheckpointId,
} from "../src/index.js";
import { createIgnoreMatcher } from "../src/internal/ignore.js";
import {
  LIFECYCLE_EVENTS,
  setDefaultLifecycleProcessAdapterForTests,
  type LifecycleEvent,
  type LifecycleHandler,
  type LifecycleProcessAdapter,
  type LifecycleSignal,
} from "../src/internal/lifecycle.js";
import { normalizeWorkspacePath } from "../src/internal/path.js";
import { PosixLinkStrategy } from "../src/internal/posix-link-strategy.js";
import { probeSessionDeviceInfo, type SessionFsAdapter } from "../src/internal/session.js";
import type { StorageStrategy } from "../src/internal/storage-strategy.js";
import { TmpfsDirtySetStrategy } from "../src/internal/tmpfs-dirty-set-strategy.js";
import type { EnvironmentProfile } from "../src/internal/environment.js";
import { HotDirtyBufferStrategy } from "../src/internal/hot-dirty-buffer-strategy.js";

const tempRoots: string[] = [];
let lifecycleAdapter: FakeLifecycleProcessAdapter;

class FakeLifecycleProcessAdapter implements LifecycleProcessAdapter {
  public readonly pid = 12345;
  private readonly handlers = new Map<LifecycleEvent, Set<LifecycleHandler>>();

  public once(event: LifecycleEvent, handler: LifecycleHandler): void {
    const handlers = this.handlers.get(event) ?? new Set<LifecycleHandler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  public off(event: LifecycleEvent, handler: LifecycleHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  public kill(_pid: number, _signal: LifecycleSignal): void {
    return;
  }

  public rethrow(reason: unknown): never {
    throw reason instanceof Error ? reason : new Error(String(reason));
  }

  public listenerCount(event: LifecycleEvent): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  public emit(event: LifecycleEvent, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(...args);
    }
  }
}

function createTempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "hyperion-workspace-"));
  tempRoots.push(root);
  return root;
}

function getManualTrackedPaths(workspace: HyperionWorkspace): string[] {
  return [
    ...(
      workspace as unknown as {
        manualTrackedPaths: Set<string>;
      }
    ).manualTrackedPaths,
  ];
}

function getManualTrackedIgnoredPaths(workspace: HyperionWorkspace): string[] {
  return [
    ...(
      workspace as unknown as {
        manualTrackedIgnoredPaths: Set<string>;
      }
    ).manualTrackedIgnoredPaths,
  ];
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

function ensureWorkspaceSessionRoot(workspace: HyperionWorkspace): string {
  return (
    workspace as unknown as {
      ensureSessionRoot(): string;
    }
  ).ensureSessionRoot();
}

function probeWorkspaceSessionDeviceInfo(workspace: HyperionWorkspace): {
  workspaceDeviceId: number;
  sessionDeviceId: number;
  sameDevice: boolean;
} {
  return (
    workspace as unknown as {
      probeSessionDeviceInfo(): {
        workspaceDeviceId: number;
        sessionDeviceId: number;
        sameDevice: boolean;
      };
    }
  ).probeSessionDeviceInfo();
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

function markWorkspaceCheckpointDisposed(
  workspace: HyperionWorkspace,
  checkpointId: CheckpointId,
): void {
  (
    workspace as unknown as {
      markCheckpointDisposed(checkpointId: CheckpointId): void;
    }
  ).markCheckpointDisposed(checkpointId);
}

function getActiveCheckpointCount(workspace: HyperionWorkspace): number {
  return (
    workspace as unknown as {
      activeCheckpointCount: number;
    }
  ).activeCheckpointCount;
}

function backupWorkspaceCheckpointPath(
  workspace: HyperionWorkspace,
  checkpointId: CheckpointId,
  pathOrPathLike: string,
): void {
  (
    workspace as unknown as {
      backupCheckpointPath(checkpointId: CheckpointId, pathOrPathLike: string): void;
    }
  ).backupCheckpointPath(checkpointId, pathOrPathLike);
}

function replaceWorkspaceCheckpointStorage(
  workspace: HyperionWorkspace,
  checkpointId: CheckpointId,
  storage: StorageStrategy,
): void {
  (
    workspace as unknown as {
      checkpointStorage: Map<CheckpointId, StorageStrategy>;
    }
  ).checkpointStorage.set(checkpointId, storage);
}

function getWorkspaceCheckpointStorage(
  workspace: HyperionWorkspace,
  checkpointId: CheckpointId,
): StorageStrategy | undefined {
  return (
    workspace as unknown as {
      checkpointStorage: Map<CheckpointId, StorageStrategy>;
    }
  ).checkpointStorage.get(checkpointId);
}

function getWorkspaceSessionDirectory(workspace: HyperionWorkspace): string {
  return (
    workspace as unknown as {
      sessionManager: { sessionDir: string };
    }
  ).sessionManager.sessionDir;
}

function replaceWorkspaceSessionGarbageCollection(
  workspace: HyperionWorkspace,
  runStartupGarbageCollection: () => void,
): void {
  (
    workspace as unknown as {
      sessionManager: { runStartupGarbageCollection: () => void };
    }
  ).sessionManager.runStartupGarbageCollection = runStartupGarbageCollection;
}

function forceWorkspaceEnvironmentProfile(
  workspace: HyperionWorkspace,
  overrides: Partial<EnvironmentProfile>,
): void {
  const target = workspace as unknown as {
    environmentProfile: EnvironmentProfile;
  };
  target.environmentProfile = {
    ...target.environmentProfile,
    ...overrides,
  };
}

function createTmpfsCheckpointStorage(
  workspaceRoot: string,
  tmpfsRoot: string,
  checkpointId: CheckpointId,
): TmpfsDirtySetStrategy {
  return new TmpfsDirtySetStrategy({
    workspaceRoot,
    tmpfsRoot,
    sessionId: "workspace-test-session",
    checkpointId,
  });
}

function createCleanupTrackingStorage(
  onCleanup: () => void,
): StorageStrategy {
  return {
    backupFile() {
      throw new Error("backupFile is not used by this test storage");
    },
    restoreFile() {
      throw new Error("restoreFile is not used by this test storage");
    },
    deleteCreatedPath() {
      throw new Error("deleteCreatedPath is not used by this test storage");
    },
    getBackupRecord() {
      return undefined;
    },
    cleanup: onCleanup,
  };
}

function runChildProcessScript(root: string, script: string): void {
  execFileSync(process.execPath, ["-e", script], {
    cwd: root,
    stdio: "ignore",
  });
}

beforeEach(() => {
  lifecycleAdapter = new FakeLifecycleProcessAdapter();
  setDefaultLifecycleProcessAdapterForTests(lifecycleAdapter);
});

afterEach(() => {
  setDefaultLifecycleProcessAdapterForTests(undefined);

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("HyperionWorkspace", () => {
  it("can instantiate with a workspace root string", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.equal(workspace.root, resolve(root));
    assert.equal(workspace.config.workspaceRoot, resolve(root));
    assert.ok(["tmpfs", "posix-link", "pure-manifest"].includes(workspace.strategy));
  });

  it("can instantiate with a config object", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({ workspaceRoot: root, useTmpfs: false });

    assert.equal(workspace.root, resolve(root));
    assert.equal(workspace.config.useTmpfs, false);
  });

  it("resolves Hot Dirty Buffer defaults and custom bounds", () => {
    const root = createTempWorkspace();
    const defaultWorkspace = new HyperionWorkspace(root);

    assert.equal(defaultWorkspace.config.useHotBuffer, true);
    assert.equal(defaultWorkspace.config.hotBufferMaxFileBytes, DEFAULT_HOT_BUFFER_MAX_FILE_BYTES);
    assert.equal(defaultWorkspace.config.hotBufferMaxTotalBytes, DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES);
    assert.equal(defaultWorkspace.config.hotBufferMaxFiles, DEFAULT_HOT_BUFFER_MAX_FILES);

    const customWorkspace = new HyperionWorkspace({
      workspaceRoot: root,
      useHotBuffer: false,
      hotBufferMaxFileBytes: 16,
      hotBufferMaxTotalBytes: 32,
      hotBufferMaxFiles: 2,
    });

    assert.equal(customWorkspace.config.useHotBuffer, false);
    assert.equal(customWorkspace.config.hotBufferMaxFileBytes, 16);
    assert.equal(customWorkspace.config.hotBufferMaxTotalBytes, 32);
    assert.equal(customWorkspace.config.hotBufferMaxFiles, 2);
  });

  it("resolves strict ignored-write defaults and custom config", () => {
    const root = createTempWorkspace();
    const defaultWorkspace = new HyperionWorkspace(root);
    const strictWorkspace = new HyperionWorkspace({
      workspaceRoot: root,
      strictIgnoredWrites: true,
    });

    assert.equal(defaultWorkspace.config.strictIgnoredWrites, false);
    assert.equal(strictWorkspace.config.strictIgnoredWrites, true);
  });

  it("rejects a missing workspace root", () => {
    const root = join(tmpdir(), `hyperion-missing-${Date.now()}`);

    assert.throws(() => new HyperionWorkspace(root), HyperionPathError);
  });

  it("rejects a file path as workspace root", () => {
    const root = createTempWorkspace();
    const filePath = join(root, "file.txt");
    writeFileSync(filePath, "not a directory");

    assert.throws(() => new HyperionWorkspace(filePath), HyperionPathError);
  });

  it("resolves default ignored patterns", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.deepEqual(workspace.config.ignoredPatterns, [...DEFAULT_IGNORED_PATTERNS]);
    assert.ok(workspace.config.ignoredPatterns.includes("node_modules/**"));
    assert.ok(workspace.config.ignoredPatterns.includes(".git/**"));
    assert.ok(workspace.config.ignoredPatterns.includes(".hyperion/**"));
  });

  it("extends default ignored patterns by default", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      ignoredPatterns: ["custom-output/**"],
    });

    assert.ok(workspace.config.ignoredPatterns.includes("node_modules/**"));
    assert.ok(workspace.config.ignoredPatterns.includes("custom-output/**"));
  });

  it("can replace default ignored patterns with overrideDefaultIgnores", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      ignoredPatterns: ["only-this/**"],
      overrideDefaultIgnores: true,
    });

    assert.deepEqual(workspace.config.ignoredPatterns, ["only-this/**"]);
  });

  it("exposes public methods with expected runtime types", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.equal(typeof workspace.track, "function");
    assert.equal(typeof workspace.snapshot, "function");
    assert.equal(typeof workspace.rollback, "function");
    assert.equal(typeof workspace.reconcile, "function");
    assert.equal(typeof workspace.dispose, "function");
    assert.equal(typeof workspace.installFsInterceptor, "function");
    assert.equal(typeof workspace.uninstallFsInterceptor, "function");
  });

  it("validates track input shape", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.doesNotThrow(() => workspace.track("src/index.ts"));
    assert.doesNotThrow(() => workspace.track(["src/index.ts", "src/workspace.ts"]));
    assert.throws(() => workspace.track([]), HyperionPathError);
    assert.throws(() => workspace.track([""]), HyperionPathError);
  });

  it("normalizes relative, absolute, and Windows-style paths to workspace-relative POSIX paths", () => {
    const root = createTempWorkspace();

    assert.equal(normalizeWorkspacePath(root, "src/index.ts"), "src/index.ts");
    assert.equal(normalizeWorkspacePath(root, join(root, "src", "workspace.ts")), "src/workspace.ts");
    assert.equal(normalizeWorkspacePath(root, "src\\internal\\path.ts"), "src/internal/path.ts");
  });

  it("rejects path traversal and paths outside the workspace", () => {
    const root = createTempWorkspace();
    const outsidePath = join(tmpdir(), `hyperion-outside-${Date.now()}.ts`);

    assert.throws(() => normalizeWorkspacePath(root, "../outside.ts"), HyperionPathError);
    assert.throws(() => normalizeWorkspacePath(root, "C:drive-relative.ts"), HyperionPathError);
    assert.throws(() => normalizeWorkspacePath(root, outsidePath), HyperionPathError);
    assert.throws(() => new HyperionWorkspace({ workspaceRoot: root, sessionRoot: "../outside" }), HyperionPathError);
  });

  it("stores tracked paths after normalization including exact ignored paths", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    workspace.track([
      "src\\index.ts",
      "node_modules/pkg/index.js",
      ".git/config",
      ".hyperion/checkpoints/session/manifest.json",
      "dist/output.js",
    ]);

    assert.deepEqual(getManualTrackedPaths(workspace), [
      "src/index.ts",
      "node_modules/pkg/index.js",
      ".git/config",
      ".hyperion/checkpoints/session/manifest.json",
      "dist/output.js",
    ]);
    assert.deepEqual(getManualTrackedIgnoredPaths(workspace), [
      "node_modules/pkg/index.js",
      ".git/config",
      ".hyperion/checkpoints/session/manifest.json",
      "dist/output.js",
    ]);
  });

  it("allows exact ignored paths to be tracked explicitly", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      ignoredPatterns: ["custom-output/**"],
      overrideDefaultIgnores: true,
    });

    workspace.track(["node_modules/pkg/index.js", "custom-output/file.txt"]);

    assert.deepEqual(getManualTrackedPaths(workspace), [
      "node_modules/pkg/index.js",
      "custom-output/file.txt",
    ]);
    assert.deepEqual(getManualTrackedIgnoredPaths(workspace), ["custom-output/file.txt"]);
  });

  it("matches constrained ignore globs used by the SDK defaults", () => {
    const matcher = createIgnoreMatcher(["node_modules/**", "generated/*.ts", "exact/path"]);

    assert.equal(matcher.matches("node_modules"), true);
    assert.equal(matcher.matches("node_modules/pkg/index.js"), true);
    assert.equal(matcher.matches("generated/client.ts"), true);
    assert.equal(matcher.matches("generated/nested/client.ts"), false);
    assert.equal(matcher.matches("exact/path/file.txt"), true);
    assert.equal(matcher.matches("src/index.ts"), false);
  });

  it("does not create the checkpoint session root during construction", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.equal(workspace.config.sessionRoot, join(resolve(root), ".hyperion", "checkpoints"));
    assert.equal(existsSync(workspace.config.sessionRoot), false);
    assert.equal(existsSync(getWorkspaceSessionDirectory(workspace)), true);
  });

  it("creates the session root lazily when requested internally", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.equal(existsSync(workspace.config.sessionRoot), false);
    assert.equal(ensureWorkspaceSessionRoot(workspace), workspace.config.sessionRoot);
    assert.equal(existsSync(workspace.config.sessionRoot), true);
  });

  it("records workspace and session device IDs for future strategy selection", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const deviceInfo = probeWorkspaceSessionDeviceInfo(workspace);

    assert.equal(typeof deviceInfo.workspaceDeviceId, "number");
    assert.equal(typeof deviceInfo.sessionDeviceId, "number");
    assert.equal(deviceInfo.sameDevice, deviceInfo.workspaceDeviceId === deviceInfo.sessionDeviceId);
  });

  it("detects cross-device session roots through injectable stat adapters", () => {
    const fakeFs: SessionFsAdapter = {
      existsSync: () => true,
      mkdirSync: () => undefined,
      statSync: (path) => ({ dev: path === "workspace" ? 10 : 20 }),
    };

    assert.deepEqual(probeSessionDeviceInfo("workspace", "session", fakeFs), {
      workspaceDeviceId: 10,
      sessionDeviceId: 20,
      sameDevice: false,
    });
  });

  it("refreshes strategy selection after lazy session root creation", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      useTmpfs: false,
      useHotBuffer: false,
    });
    forceWorkspaceEnvironmentProfile(workspace, {
      platform: "darwin",
      hasRsync: true,
      hasDevShm: false,
      devShmWritable: false,
      sameDeviceForLinks: false,
    });

    const checkpointId = await workspace.snapshot();
    const storage = getWorkspaceCheckpointStorage(workspace, checkpointId);

    assert.equal(workspace.strategy, "posix-link");
    assert.equal(storage instanceof PosixLinkStrategy, true);
  });

  it("wraps checkpoint storage in the Hot Dirty Buffer by default", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    const checkpointId = await workspace.snapshot();
    const storage = getWorkspaceCheckpointStorage(workspace, checkpointId);

    assert.equal(storage instanceof HotDirtyBufferStrategy, true);
    assert.ok(["tmpfs", "posix-link", "pure-manifest"].includes(workspace.strategy));
  });

  it("can disable Hot Dirty Buffer checkpoint storage wrapping", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      useTmpfs: false,
      useHotBuffer: false,
    });

    const checkpointId = await workspace.snapshot();
    const storage = getWorkspaceCheckpointStorage(workspace, checkpointId);

    assert.equal(storage instanceof HotDirtyBufferStrategy, false);
  });

  it("creates a checkpoint when snapshot is called", async () => {
    const root = createTempWorkspace();
    writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
    const workspace = new HyperionWorkspace(root);

    const checkpointId = await workspace.snapshot();
    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);

    assert.equal(typeof checkpointId, "string");
    assert.ok(checkpointId.length > 0);
    assert.ok(checkpoint);
    assert.equal(checkpoint.id, checkpointId);
    assert.equal(checkpoint.status, "active");
    assert.equal(checkpoint.baseline.statEntries.has("source.ts"), true);
    assert.equal(checkpoint.storageNamespace, join(workspace.config.sessionRoot, checkpointId));
    assert.equal(existsSync(workspace.config.sessionRoot), true);
  });

  it("keeps snapshot namespace allocation from touching unrelated files", async () => {
    const root = createTempWorkspace();
    const filePath = join(root, "source.ts");
    writeFileSync(filePath, "original");
    const workspace = new HyperionWorkspace(root);

    await workspace.snapshot();

    assert.equal(existsSync(filePath), true);
    assert.equal(existsSync(join(root, ".hyperion", "checkpoints")), true);
    assert.equal(existsSync(join(root, "source.ts", "unexpected")), false);
  });

  it("supports concurrent active checkpoints with isolated maps and namespaces", async () => {
    const root = createTempWorkspace();
    writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
    const workspace = new HyperionWorkspace(root);

    const firstId = await workspace.snapshot();
    const secondId = await workspace.snapshot();
    const firstCheckpoint = getWorkspaceCheckpoint(workspace, firstId);
    const secondCheckpoint = getWorkspaceCheckpoint(workspace, secondId);

    assert.ok(firstCheckpoint);
    assert.ok(secondCheckpoint);
    assert.notEqual(firstId, secondId);
    assert.notEqual(firstCheckpoint.storageNamespace, secondCheckpoint.storageNamespace);
    assert.notStrictEqual(firstCheckpoint.baseline.gitIndexEntries, secondCheckpoint.baseline.gitIndexEntries);
    assert.notStrictEqual(firstCheckpoint.baseline.statEntries, secondCheckpoint.baseline.statEntries);
    assert.notStrictEqual(firstCheckpoint.dirty, secondCheckpoint.dirty);
    assert.equal(getActiveCheckpointCount(workspace), 2);
  });

  it("enforces maxConcurrentCheckpoints and throws only after disposed checkpoints are collected", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      maxConcurrentCheckpoints: 1,
    });

    const firstId = await workspace.snapshot();

    await assert.rejects(() => workspace.snapshot(), HyperionCapacityError);

    markWorkspaceCheckpointDisposed(workspace, firstId);
    const secondId = await workspace.snapshot();

    assert.notEqual(secondId, firstId);
    assert.equal(getWorkspaceCheckpoint(workspace, firstId), undefined);
    assert.ok(getWorkspaceCheckpoint(workspace, secondId));
    assert.equal(getActiveCheckpointCount(workspace), 1);
  });

  it("cleans disposed checkpoint storage before creating a new snapshot", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      maxConcurrentCheckpoints: 1,
    });
    const firstId = await workspace.snapshot();
    let cleanupCount = 0;
    replaceWorkspaceCheckpointStorage(
      workspace,
      firstId,
      createCleanupTrackingStorage(() => {
        cleanupCount += 1;
      }),
    );

    markWorkspaceCheckpointDisposed(workspace, firstId);
    const secondId = await workspace.snapshot();

    assert.notEqual(secondId, firstId);
    assert.equal(cleanupCount, 1);
    assert.equal(getWorkspaceCheckpoint(workspace, firstId), undefined);
    assert.equal(getWorkspaceCheckpointStorage(workspace, firstId), undefined);
    assert.ok(getWorkspaceCheckpoint(workspace, secondId));
  });

  it("capacity GC attempts every disposed checkpoint storage namespace", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      maxConcurrentCheckpoints: 2,
    });
    const firstId = await workspace.snapshot();
    const secondId = await workspace.snapshot();
    const cleanedIds: CheckpointId[] = [];
    replaceWorkspaceCheckpointStorage(
      workspace,
      firstId,
      createCleanupTrackingStorage(() => {
        cleanedIds.push(firstId);
      }),
    );
    replaceWorkspaceCheckpointStorage(
      workspace,
      secondId,
      createCleanupTrackingStorage(() => {
        cleanedIds.push(secondId);
      }),
    );

    markWorkspaceCheckpointDisposed(workspace, firstId);
    markWorkspaceCheckpointDisposed(workspace, secondId);
    const thirdId = await workspace.snapshot();

    assert.deepEqual(cleanedIds.sort(), [firstId, secondId].sort());
    assert.equal(getWorkspaceCheckpoint(workspace, firstId), undefined);
    assert.equal(getWorkspaceCheckpoint(workspace, secondId), undefined);
    assert.ok(getWorkspaceCheckpoint(workspace, thirdId));
  });

  it("swallows disposed checkpoint storage cleanup errors while freeing capacity", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      maxConcurrentCheckpoints: 1,
    });
    const firstId = await workspace.snapshot();
    replaceWorkspaceCheckpointStorage(
      workspace,
      firstId,
      createCleanupTrackingStorage(() => {
        throw new Error("cleanup failed");
      }),
    );

    markWorkspaceCheckpointDisposed(workspace, firstId);
    const secondId = await workspace.snapshot();

    assert.equal(getWorkspaceCheckpoint(workspace, firstId), undefined);
    assert.equal(getWorkspaceCheckpointStorage(workspace, firstId), undefined);
    assert.ok(getWorkspaceCheckpoint(workspace, secondId));
  });

  it("keeps active checkpoints protected when capacity GC cannot free space", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      maxConcurrentCheckpoints: 1,
    });
    const firstId = await workspace.snapshot();
    let cleanupCount = 0;
    let sessionGcCount = 0;
    replaceWorkspaceCheckpointStorage(
      workspace,
      firstId,
      createCleanupTrackingStorage(() => {
        cleanupCount += 1;
      }),
    );
    replaceWorkspaceSessionGarbageCollection(workspace, () => {
      sessionGcCount += 1;
    });

    await assert.rejects(() => workspace.snapshot(), HyperionCapacityError);

    assert.equal(cleanupCount, 0);
    assert.equal(sessionGcCount, 1);
    assert.ok(getWorkspaceCheckpoint(workspace, firstId));
    assert.ok(getWorkspaceCheckpointStorage(workspace, firstId));
  });

  it("clears checkpoints during dispose and rejects snapshots after disposal", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    const checkpointId = await workspace.snapshot();
    assert.ok(getWorkspaceCheckpoint(workspace, checkpointId));

    await workspace.dispose();
    await workspace.dispose();

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId), undefined);
    assert.equal(getActiveCheckpointCount(workspace), 0);
    await assert.rejects(() => workspace.snapshot(), HyperionError);
  });

  it("reconciles child-process created, modified, and deleted paths", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const modifiedPath = join(root, "modified.txt");
    const deletedPath = join(root, "deleted.txt");
    writeFileSync(modifiedPath, "original");
    writeFileSync(deletedPath, "remove me");
    const checkpointId = await workspace.snapshot();

    runChildProcessScript(
      root,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(join(root, "child-created.txt"))}, "created");`,
        `fs.writeFileSync(${JSON.stringify(modifiedPath)}, "mutated content");`,
        `fs.rmSync(${JSON.stringify(deletedPath)}, { force: true });`,
      ].join("\n"),
    );

    const result = await workspace.reconcile(checkpointId);
    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);

    assert.equal(result.created.includes("child-created.txt"), true);
    assert.equal(result.modified.includes("modified.txt"), true);
    assert.equal(result.deleted.includes("deleted.txt"), true);
    assert.equal(checkpoint?.dirty.has("child-created.txt"), true);
    assert.equal(checkpoint?.dirty.has("modified.txt"), true);
    assert.equal(checkpoint?.dirty.has("deleted.txt"), true);
  });

  it("reconciles the most recent active checkpoint when no checkpoint id is provided", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const firstId = await workspace.snapshot();
    const secondId = await workspace.snapshot();
    writeFileSync(join(root, "latest-created.txt"), "created");

    const result = await workspace.reconcile();

    assert.equal(result.checkpointId, secondId);
    assert.equal(result.created.includes("latest-created.txt"), true);
    assert.equal(getWorkspaceCheckpoint(workspace, firstId)?.dirty.has("latest-created.txt"), false);
    assert.equal(getWorkspaceCheckpoint(workspace, secondId)?.dirty.has("latest-created.txt"), true);
  });

  it("keeps reconciliation idempotent for repeated captures", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    writeFileSync(join(root, "created-once.txt"), "created");

    await workspace.reconcile(checkpointId);
    const firstEntry = getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.get("created-once.txt");
    await workspace.reconcile(checkpointId);
    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);
    const secondEntry = checkpoint?.dirty.get("created-once.txt");

    assert.equal(checkpoint?.dirty.size, 1);
    assert.equal(secondEntry?.firstSeenAt, firstEntry?.firstSeenAt);
    assert.equal(secondEntry?.capturedBy, "reconcile");
  });

  it("ignores child-process writes under default ignored directories", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();

    runChildProcessScript(
      root,
      [
        "const fs = require('node:fs');",
        `fs.mkdirSync(${JSON.stringify(join(root, "node_modules", "pkg"))}, { recursive: true });`,
        `fs.mkdirSync(${JSON.stringify(join(root, ".git"))}, { recursive: true });`,
        `fs.mkdirSync(${JSON.stringify(join(root, ".hyperion", "scratch"))}, { recursive: true });`,
        `fs.writeFileSync(${JSON.stringify(join(root, "node_modules", "pkg", "index.js"))}, "ignored");`,
        `fs.writeFileSync(${JSON.stringify(join(root, ".git", "config"))}, "ignored");`,
        `fs.writeFileSync(${JSON.stringify(join(root, ".hyperion", "scratch", "file.txt"))}, "ignored");`,
      ].join("\n"),
    );

    assert.deepEqual(await workspace.reconcile(checkpointId), {
      checkpointId,
      created: [],
      modified: [],
      deleted: [],
      renamed: [],
    });
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.size, 0);
  });

  it("removes reconciled dirty entries after a created path returns to baseline", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const createdPath = join(root, "created-then-removed.txt");

    writeFileSync(createdPath, "created");
    await workspace.reconcile(checkpointId);
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.has("created-then-removed.txt"), true);

    rmSync(createdPath, { force: true });
    await workspace.reconcile(checkpointId);

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.has("created-then-removed.txt"), false);
  });

  it("deletes files created after snapshot during rollback", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const unrelatedFile = join(root, "unrelated.txt");
    writeFileSync(unrelatedFile, "safe");
    const checkpointId = await workspace.snapshot();
    const createdFile = join(root, "created.txt");
    writeFileSync(createdFile, "created");

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(createdFile), false);
    assert.equal(readFileSync(unrelatedFile, "utf8"), "safe");
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.status, "disposed");
  });

  it("restores modified files when a backup record exists", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const sourcePath = join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const checkpointId = await workspace.snapshot();
    backupWorkspaceCheckpointPath(workspace, checkpointId, "source.txt");
    writeFileSync(sourcePath, "mutated");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });

  it("recreates deleted files when a backup record exists", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const sourcePath = join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const checkpointId = await workspace.snapshot();
    backupWorkspaceCheckpointPath(workspace, checkpointId, "source.txt");
    rmSync(sourcePath, { force: true });

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });

  it("cleans checkpoint storage after successful rollback", async () => {
    const root = createTempWorkspace();
    const tmpfsRoot = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const sourcePath = join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const checkpointId = await workspace.snapshot();
    const storage = createTmpfsCheckpointStorage(root, tmpfsRoot, checkpointId);
    replaceWorkspaceCheckpointStorage(workspace, checkpointId, storage);
    backupWorkspaceCheckpointPath(workspace, checkpointId, "source.txt");
    writeFileSync(sourcePath, "mutated");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
    assert.equal(existsSync(storage.backupNamespace), false);
  });

  it("leaves checkpoint storage intact after failed rollback", async () => {
    const root = createTempWorkspace();
    const tmpfsRoot = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const sourcePath = join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const checkpointId = await workspace.snapshot();
    const storage = createTmpfsCheckpointStorage(root, tmpfsRoot, checkpointId);
    replaceWorkspaceCheckpointStorage(workspace, checkpointId, storage);
    writeFileSync(sourcePath, "mutated");

    await assert.rejects(() => workspace.rollback(checkpointId), HyperionIntegrityError);

    assert.equal(existsSync(storage.backupNamespace), true);
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.status, "active");
  });

  it("cleans active checkpoint storage namespaces during dispose", async () => {
    const root = createTempWorkspace();
    const tmpfsRoot = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const firstId = await workspace.snapshot();
    const secondId = await workspace.snapshot();
    const firstStorage = createTmpfsCheckpointStorage(root, tmpfsRoot, firstId);
    const secondStorage = createTmpfsCheckpointStorage(root, tmpfsRoot, secondId);
    replaceWorkspaceCheckpointStorage(workspace, firstId, firstStorage);
    replaceWorkspaceCheckpointStorage(workspace, secondId, secondStorage);

    await workspace.dispose();

    assert.equal(existsSync(firstStorage.backupNamespace), false);
    assert.equal(existsSync(secondStorage.backupNamespace), false);
  });

  it("throws integrity errors for modified files without backup records", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const sourcePath = join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const checkpointId = await workspace.snapshot();
    writeFileSync(sourcePath, "mutated");

    await assert.rejects(() => workspace.rollback(checkpointId), HyperionIntegrityError);

    const checkpoint = getWorkspaceCheckpoint(workspace, checkpointId);
    assert.equal(checkpoint?.status, "active");
    assert.equal(readFileSync(sourcePath, "utf8"), "mutated");
  });

  it("calls reconcile before rollback and records dirty entries", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    writeFileSync(join(root, "created.txt"), "created");
    const originalReconcile = workspace.reconcile.bind(workspace);
    let reconcileCalled = false;

    workspace.reconcile = async (id?: CheckpointId) => {
      reconcileCalled = true;
      return originalReconcile(id);
    };

    await workspace.rollback(checkpointId);

    assert.equal(reconcileCalled, true);
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.has("created.txt"), true);
  });

  it("rolls back child-process created files without an explicit reconcile call", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const createdPath = join(root, "external-created.txt");

    runChildProcessScript(
      root,
      `require('node:fs').writeFileSync(${JSON.stringify(createdPath)}, "created");`,
    );

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(createdPath), false);
  });

  it("rejects concurrent rollback on the same checkpoint and releases the lock", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    let releaseReconcile: (() => void) | undefined;
    const reconcileGate = new Promise<void>((resolveGate) => {
      releaseReconcile = resolveGate;
    });

    workspace.reconcile = async () => {
      await reconcileGate;
      return {
        checkpointId,
        created: [],
        modified: [],
        deleted: [],
        renamed: [],
      };
    };

    const firstRollback = workspace.rollback(checkpointId);
    await assert.rejects(() => workspace.rollback(checkpointId), HyperionRollbackError);
    releaseReconcile?.();
    await firstRollback;

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.status, "disposed");
  });

  it("removes ghost directories bottom-up while preserving pre-existing parents", async () => {
    const root = createTempWorkspace();
    mkdirSync(join(root, "src"), { recursive: true });
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    mkdirSync(join(root, "src", "scratch", "nested"), { recursive: true });
    writeFileSync(join(root, "src", "scratch", "nested", "created.txt"), "created");

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(join(root, "src", "scratch")), false);
    assert.equal(existsSync(join(root, "src")), true);
  });

  it("rejects unknown and disposed checkpoint rollback", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();

    await assert.rejects(() => workspace.rollback("missing-checkpoint"), HyperionRollbackError);
    markWorkspaceCheckpointDisposed(workspace, checkpointId);
    await assert.rejects(() => workspace.rollback(checkpointId), HyperionRollbackError);
  });

  it("returns an empty reconcile result without an active checkpoint", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.deepEqual(await workspace.reconcile(), {
      created: [],
      modified: [],
      deleted: [],
      renamed: [],
    });
  });

  it("registers lifecycle hooks during construction", () => {
    const root = createTempWorkspace();
    new HyperionWorkspace(root);

    for (const event of LIFECYCLE_EVENTS) {
      assert.equal(lifecycleAdapter.listenerCount(event), 1);
    }
  });

  it("creates a current session directory with a lockfile during construction", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const sessionDir = getWorkspaceSessionDirectory(workspace);
    const sessionNames = readdirSync(join(root, ".hyperion")).filter((entry) =>
      entry.startsWith("session-"),
    );
    const lockfile = JSON.parse(readFileSync(join(sessionDir, "lock.json"), "utf8")) as {
      sessionId: string;
      pid: number;
    };

    assert.equal(existsSync(sessionDir), true);
    assert.equal(sessionNames.length, 1);
    assert.equal(typeof lockfile.sessionId, "string");
    assert.equal(typeof lockfile.pid, "number");
  });

  it("unregisters lifecycle hooks during idempotent dispose", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    await workspace.dispose();
    await workspace.dispose();

    for (const event of LIFECYCLE_EVENTS) {
      assert.equal(lifecycleAdapter.listenerCount(event), 0);
    }
  });

  it("removes the current session directory during dispose", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const sessionDir = getWorkspaceSessionDirectory(workspace);

    await workspace.dispose();
    await workspace.dispose();

    assert.equal(existsSync(sessionDir), false);
  });

  it("emergency cleanup uninstalls the fs interceptor", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    workspace.installFsInterceptor();

    lifecycleAdapter.emit("exit", 0);

    assert.equal(workspace.isFsInterceptorInstalled, false);
  });

  it("emergency cleanup removes the current session directory", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const sessionDir = getWorkspaceSessionDirectory(workspace);

    lifecycleAdapter.emit("exit", 0);

    assert.equal(existsSync(sessionDir), false);
  });

  it("emergency cleanup invokes every active checkpoint storage cleanup", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const firstId = await workspace.snapshot();
    const secondId = await workspace.snapshot();
    let secondCleanupCalled = false;
    replaceWorkspaceCheckpointStorage(
      workspace,
      firstId,
      createCleanupTrackingStorage(() => {
        throw new Error("cleanup failed");
      }),
    );
    replaceWorkspaceCheckpointStorage(
      workspace,
      secondId,
      createCleanupTrackingStorage(() => {
        secondCleanupCalled = true;
      }),
    );

    lifecycleAdapter.emit("exit", 0);

    assert.equal(secondCleanupCalled, true);
  });

  it("emergency cleanup touches only known checkpoint storage namespaces", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const ownedNamespace = join(root, "owned-storage");
    const unrelatedPath = join(root, "unrelated.txt");
    mkdirSync(ownedNamespace, { recursive: true });
    writeFileSync(join(ownedNamespace, "backup.txt"), "backup");
    writeFileSync(unrelatedPath, "safe");
    replaceWorkspaceCheckpointStorage(
      workspace,
      checkpointId,
      createCleanupTrackingStorage(() => {
        rmSync(ownedNamespace, { recursive: true, force: true });
      }),
    );

    lifecycleAdapter.emit("exit", 0);

    assert.equal(existsSync(ownedNamespace), false);
    assert.equal(readFileSync(unrelatedPath, "utf8"), "safe");
  });

  it("has idempotent no-op interceptor and dispose methods", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    workspace.installFsInterceptor();
    workspace.installFsInterceptor();
    assert.equal(workspace.isFsInterceptorInstalled, true);

    workspace.uninstallFsInterceptor();
    workspace.uninstallFsInterceptor();
    assert.equal(workspace.isFsInterceptorInstalled, false);

    await workspace.dispose();
    await workspace.dispose();
    assert.equal(workspace.isDisposed, true);
  });
});
