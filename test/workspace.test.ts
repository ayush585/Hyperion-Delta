import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
import { NtfsLinkStrategy } from "../src/internal/ntfs-link-strategy.js";
import { probeSessionDeviceInfo, type SessionFsAdapter } from "../src/internal/session.js";
import type { StorageStrategy } from "../src/internal/storage-strategy.js";
import { TmpfsDirtySetStrategy } from "../src/internal/tmpfs-dirty-set-strategy.js";
import type { EnvironmentProfile } from "../src/internal/environment.js";
import { HotDirtyBufferStrategy } from "../src/internal/hot-dirty-buffer-strategy.js";

const require = createRequire(import.meta.url);
const tempRoots: string[] = [];
let lifecycleAdapter: FakeLifecycleProcessAdapter;

function getCommonJsFs(): typeof import("node:fs") {
  return require("node:fs") as typeof import("node:fs");
}

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

function getWorkspaceJournalPath(root: string, checkpointId: CheckpointId): string {
  return join(root, ".hyperion", "checkpoints", checkpointId, "journal.json");
}

function getWorkspaceBackupManifestPath(root: string, checkpointId: CheckpointId): string {
  return join(root, ".hyperion", "checkpoints", checkpointId, "backups.json");
}

function readWorkspaceJournal(root: string, checkpointId: CheckpointId): {
  checkpointId: string;
  sessionId: string;
  status: string;
  strategy: string;
  dirty: Array<{ relativePath: string; kind: string; capturedBy: string }>;
  baseline: {
    gitIndexEntries: Array<{ relativePath: string }>;
    statEntries: Array<{ relativePath: string }>;
  };
  ignoredPatterns: string[];
  gitHead?: string;
} {
  return JSON.parse(readFileSync(getWorkspaceJournalPath(root, checkpointId), "utf8")) as {
    checkpointId: string;
    sessionId: string;
    status: string;
    strategy: string;
    dirty: Array<{ relativePath: string; kind: string; capturedBy: string }>;
    baseline: {
      gitIndexEntries: Array<{ relativePath: string }>;
      statEntries: Array<{ relativePath: string }>;
    };
    ignoredPatterns: string[];
    gitHead?: string;
  };
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
    getBackupRecords() {
      return [];
    },
    readBackupFile() {
      return undefined;
    },
    getDiagnostics() {
      return {
        physicalStrategy: "pure-manifest",
        backupRecordCount: 0,
        hotBuffer: {
          enabled: false,
          memoryHits: 0,
          spills: 0,
          bytesUsed: 0,
          filesUsed: 0,
        },
      } as const;
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
    assert.ok(["tmpfs", "posix-link", "ntfs-link", "pure-manifest"].includes(workspace.strategy));
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

  it("resolves durable attempt journal defaults and custom config", () => {
    const root = createTempWorkspace();
    const defaultWorkspace = new HyperionWorkspace(root);
    const disabledWorkspace = new HyperionWorkspace({
      workspaceRoot: root,
      durableAttemptJournals: false,
    });

    assert.equal(defaultWorkspace.config.durableAttemptJournals, true);
    assert.equal(disabledWorkspace.config.durableAttemptJournals, false);
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
    assert.equal(typeof workspace.recoverAttempts, "function");
    assert.equal(typeof workspace.exportPatch, "function");
    assert.equal(typeof workspace.getDiagnostics, "function");
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

  it("declares exact tool outputs and rejects invalid contract paths", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();

    assert.doesNotThrow(() => {
      workspace.declareToolOutputs({
        toolName: "npm",
        checkpointId,
        outputs: [
          "node_modules/.cache/npm/output.json",
          { path: "dist/generated.js", optional: true },
        ],
      });
    });
    assert.throws(
      () => workspace.declareToolOutputs({ toolName: "npm", outputs: [] }),
      HyperionPathError,
    );
    assert.throws(
      () => workspace.declareToolOutputs({ toolName: "", outputs: ["dist/file.js"] }),
      HyperionPathError,
    );
    assert.throws(
      () => workspace.declareToolOutputs({ toolName: "npm", outputs: ["../outside.txt"] }),
      HyperionPathError,
    );
  });

  it("returns immutable diagnostics snapshots for strategy, checkpoints, and hot buffer usage", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    writeFileSync(join(root, "source.txt"), "before");
    const workspace = new HyperionWorkspace(root);
    workspace.installFsInterceptor();
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(join(root, "source.txt"), "after");

    const diagnostics = workspace.getDiagnostics();
    const checkpointDiagnostics = diagnostics.checkpoints.find(
      (checkpoint) => checkpoint.checkpointId === checkpointId,
    );

    assert.equal(diagnostics.strategy, workspace.strategy);
    assert.equal(diagnostics.activeCheckpointCount, 1);
    assert.equal(diagnostics.isDisposed, false);
    assert.equal(checkpointDiagnostics?.status, "active");
    assert.equal(checkpointDiagnostics?.storage?.hotBuffer.enabled, true);
    assert.equal(checkpointDiagnostics?.storage?.hotBuffer.memoryHits, 1);
    assert.equal(checkpointDiagnostics?.storage?.backupRecordCount, 1);

    diagnostics.checkpoints.length = 0;
    diagnostics.ignoredWrites.push({
      relativePath: "fake.txt",
      kind: "write",
      capturedAt: 1,
      action: "ignored",
    });

    const freshDiagnostics = workspace.getDiagnostics();
    assert.equal(freshDiagnostics.checkpoints.length, 1);
    assert.equal(freshDiagnostics.ignoredWrites.some((event) => event.relativePath === "fake.txt"), false);
  });

  it("records bounded ignored-write diagnostics for ignored, blocked, and declared actions", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const workspace = new HyperionWorkspace(root);
    workspace.installFsInterceptor();

    for (let index = 0; index < 105; index += 1) {
      fs.writeFileSync(join(root, "node_modules", `ignored-${index}.txt`), "ignored");
    }

    const diagnostics = workspace.getDiagnostics();
    assert.equal(diagnostics.ignoredWrites.length, 100);
    assert.equal(diagnostics.ignoredWrites[0]?.relativePath, "node_modules/ignored-5.txt");
    assert.equal(diagnostics.ignoredWrites[diagnostics.ignoredWrites.length - 1]?.action, "ignored");

    const strictRoot = createTempWorkspace();
    const strictFs = getCommonJsFs();
    mkdirSync(join(strictRoot, "node_modules"), { recursive: true });
    const strictWorkspace = new HyperionWorkspace({
      workspaceRoot: strictRoot,
      strictIgnoredWrites: true,
    });
    strictWorkspace.installFsInterceptor();

    assert.throws(
      () => strictFs.writeFileSync(join(strictRoot, "node_modules", "blocked.txt"), "blocked"),
      HyperionIgnoredPathError,
    );
    const strictIgnoredWrites = strictWorkspace.getDiagnostics().ignoredWrites;
    assert.equal(strictIgnoredWrites[strictIgnoredWrites.length - 1]?.action, "blocked");

    const declaredRoot = createTempWorkspace();
    const declaredFs = getCommonJsFs();
    mkdirSync(join(declaredRoot, "node_modules"), { recursive: true });
    const declaredWorkspace = new HyperionWorkspace({
      workspaceRoot: declaredRoot,
      strictIgnoredWrites: true,
    });
    declaredWorkspace.installFsInterceptor();
    const checkpointId = await declaredWorkspace.snapshot();
    declaredWorkspace.declareToolOutputs({
      toolName: "npm",
      checkpointId,
      outputs: ["node_modules/declared.txt"],
    });

    declaredFs.writeFileSync(join(declaredRoot, "node_modules", "declared.txt"), "declared");

    const declaredIgnoredWrites = declaredWorkspace.getDiagnostics().ignoredWrites;
    assert.equal(declaredIgnoredWrites[declaredIgnoredWrites.length - 1]?.action, "declared");
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

  it("refreshes Windows strategy selection to ntfs-link after hard-link probing", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      useTmpfs: false,
      useHotBuffer: false,
    });
    forceWorkspaceEnvironmentProfile(workspace, {
      platform: "win32",
      hasRsync: false,
      hasDevShm: false,
      devShmWritable: false,
      sameDeviceForLinks: false,
      windowsVolume: {
        fileSystemName: "NTFS",
        isDevDrive: false,
        devDriveTrusted: false,
        hardLinkCapable: false,
        blockCloneCandidate: false,
      },
    });

    const checkpointId = await workspace.snapshot();
    const storage = getWorkspaceCheckpointStorage(workspace, checkpointId);
    const diagnostics = workspace.getDiagnostics();

    assert.equal(workspace.strategy, "ntfs-link");
    assert.equal(storage instanceof NtfsLinkStrategy, true);
    assert.equal(diagnostics.windowsVolume?.fileSystemName, "NTFS");
    assert.equal(diagnostics.windowsVolume?.hardLinkCapable, true);
  });

  it("wraps checkpoint storage in the Hot Dirty Buffer by default", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    const checkpointId = await workspace.snapshot();
    const storage = getWorkspaceCheckpointStorage(workspace, checkpointId);

    assert.equal(storage instanceof HotDirtyBufferStrategy, true);
    assert.ok(["tmpfs", "posix-link", "ntfs-link", "pure-manifest"].includes(workspace.strategy));
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

  it("writes a durable attempt journal before snapshot returns", async () => {
    const root = createTempWorkspace();
    writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
    const workspace = new HyperionWorkspace(root);

    const checkpointId = await workspace.snapshot();
    const journal = readWorkspaceJournal(root, checkpointId);

    assert.equal(existsSync(getWorkspaceJournalPath(root, checkpointId)), true);
    assert.equal(journal.checkpointId, checkpointId);
    assert.equal(typeof journal.sessionId, "string");
    assert.equal(journal.status, "active");
    assert.equal(journal.strategy, workspace.strategy);
    assert.equal(journal.baseline.statEntries.some((entry) => entry.relativePath === "source.ts"), true);
    assert.equal(journal.ignoredPatterns.includes("node_modules/**"), true);
    assert.equal(JSON.stringify(journal).includes("export const value"), false);
  });

  it("can disable durable attempt journal creation", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      durableAttemptJournals: false,
    });

    const checkpointId = await workspace.snapshot();

    assert.equal(existsSync(getWorkspaceJournalPath(root, checkpointId)), false);
    assert.deepEqual(await workspace.recoverAttempts(), []);
  });

  it("updates durable attempt journals after VFS mutation and reconcile", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const workspace = new HyperionWorkspace(root);
    workspace.installFsInterceptor();
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(join(root, "created-by-vfs.txt"), "created");
    let journal = readWorkspaceJournal(root, checkpointId);

    assert.equal(journal.dirty.length, 1);
    assert.equal(journal.dirty[0]?.relativePath, "created-by-vfs.txt");
    assert.equal(journal.dirty[0]?.capturedBy, "vfs");

    fs.writeFileSync(join(root, "created-by-reconcile.txt"), "created");
    await workspace.reconcile(checkpointId);
    journal = readWorkspaceJournal(root, checkpointId);

    assert.equal(
      journal.dirty.some((entry) => entry.relativePath === "created-by-reconcile.txt"),
      true,
    );
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

  it("marks active attempt journals disposed during dispose", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();

    await workspace.dispose();

    assert.equal(readWorkspaceJournal(root, checkpointId).status, "disposed");
  });

  it("recovers durable attempt journal summaries from a fresh workspace", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    writeFileSync(join(root, "created.txt"), "created");
    await workspace.reconcile(checkpointId);
    const corruptDir = join(root, ".hyperion", "checkpoints", "corrupt");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "journal.json"), "{not-json");

    const freshWorkspace = new HyperionWorkspace(root);
    const attempts = await freshWorkspace.recoverAttempts();
    const recovered = attempts.find((attempt) => attempt.checkpointId === checkpointId);

    assert.ok(recovered);
    assert.equal(recovered.sessionId, readWorkspaceJournal(root, checkpointId).sessionId);
    assert.equal(recovered.status, "active");
    assert.equal(recovered.strategy, workspace.strategy);
    assert.equal(recovered.dirtyCount, 1);
    assert.equal(recovered.journalPath, getWorkspaceJournalPath(root, checkpointId));
    assert.equal(recovered.canRehydrate, true);
    assert.equal(attempts.some((attempt) => attempt.checkpointId === "corrupt"), false);
  });

  it("rehydrates created-file-only attempts and rolls them back from a fresh workspace", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    writeFileSync(join(root, "created.txt"), "created");
    await workspace.reconcile(checkpointId);

    const freshWorkspace = new HyperionWorkspace(root);
    await freshWorkspace.rehydrateAttempt(checkpointId);
    await freshWorkspace.rollback(checkpointId);

    assert.equal(existsSync(join(root, "created.txt")), false);
  });

  it("rehydrates durable modified attempts and supports patch export", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      useHotBuffer: false,
      useTmpfs: false,
    });
    workspace.installFsInterceptor();
    writeFileSync(join(root, "source.txt"), "before\n");
    const checkpointId = await workspace.snapshot();
    fs.writeFileSync(join(root, "source.txt"), "after\n");
    workspace.uninstallFsInterceptor();

    assert.equal(existsSync(getWorkspaceBackupManifestPath(root, checkpointId)), true);

    const freshWorkspace = new HyperionWorkspace({
      workspaceRoot: root,
      useHotBuffer: false,
      useTmpfs: false,
    });
    await freshWorkspace.rehydrateAttempt(checkpointId);
    const patch = await freshWorkspace.exportPatch(checkpointId);

    assert.match(patch, /-before/);
    assert.match(patch, /\+after/);

    await freshWorkspace.rollback(checkpointId);
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "before\n");
  });

  it("reports volatile Hot Dirty Buffer attempts as non-rehydratable", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const workspace = new HyperionWorkspace(root);
    workspace.installFsInterceptor();
    writeFileSync(join(root, "source.txt"), "before\n");
    const checkpointId = await workspace.snapshot();
    fs.writeFileSync(join(root, "source.txt"), "after\n");
    workspace.uninstallFsInterceptor();

    const freshWorkspace = new HyperionWorkspace(root);
    const attempt = (await freshWorkspace.recoverAttempts()).find(
      (recoverableAttempt) => recoverableAttempt.checkpointId === checkpointId,
    );

    assert.equal(attempt?.canRehydrate, false);
    assert.match(attempt?.nonRehydratableReason ?? "", /volatile/);
    await assert.rejects(() => freshWorkspace.rehydrateAttempt(checkpointId), HyperionIntegrityError);
  });

  it("rejects rehydration for disposed attempts and missing durable backups", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      useHotBuffer: false,
      useTmpfs: false,
    });
    writeFileSync(join(root, "disposed.txt"), "before\n");
    const disposedId = await workspace.snapshot();
    markWorkspaceCheckpointDisposed(workspace, disposedId);

    const fs = getCommonJsFs();
    workspace.installFsInterceptor();
    writeFileSync(join(root, "source.txt"), "before\n");
    const missingBackupId = await workspace.snapshot();
    fs.writeFileSync(join(root, "source.txt"), "after\n");
    workspace.uninstallFsInterceptor();
    const backupManifest = JSON.parse(
      readFileSync(getWorkspaceBackupManifestPath(root, missingBackupId), "utf8"),
    ) as { records: Array<{ backupPath?: string }> };
    const backupPath = backupManifest.records[0]?.backupPath;
    if (backupPath) {
      rmSync(backupPath, { force: true });
    }

    const freshWorkspace = new HyperionWorkspace({
      workspaceRoot: root,
      useHotBuffer: false,
      useTmpfs: false,
    });

    await assert.rejects(() => freshWorkspace.rehydrateAttempt(disposedId), HyperionRollbackError);
    await assert.rejects(() => freshWorkspace.rehydrateAttempt(missingBackupId), HyperionIntegrityError);
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

  it("exports a patch for created files and reconciles child-process creates first", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    runChildProcessScript(
      root,
      `require('node:fs').writeFileSync(${JSON.stringify(join(root, "created.txt"))}, "created\\n");`,
    );

    const patch = await workspace.exportPatch(checkpointId);

    assert.match(patch, /diff --git a\/created\.txt b\/created\.txt/);
    assert.match(patch, /--- \/dev\/null/);
    assert.match(patch, /\+\+\+ b\/created\.txt/);
    assert.match(patch, /@@ -0,0 \+1 @@/);
    assert.match(patch, /\+created/);
    assert.equal(existsSync(join(root, "created.txt")), true);
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.status, "active");
  });

  it("exports patches for VFS-backed modified and deleted files", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const workspace = new HyperionWorkspace(root);
    workspace.installFsInterceptor();
    writeFileSync(join(root, "modified.txt"), "before\n");
    writeFileSync(join(root, "deleted.txt"), "remove\n");
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(join(root, "modified.txt"), "after\n");
    fs.unlinkSync(join(root, "deleted.txt"));
    const patch = await workspace.exportPatch(checkpointId);

    assert.match(patch, /diff --git a\/deleted\.txt b\/deleted\.txt/);
    assert.match(patch, /--- a\/deleted\.txt/);
    assert.match(patch, /\+\+\+ \/dev\/null/);
    assert.match(patch, /-remove/);
    assert.match(patch, /diff --git a\/modified\.txt b\/modified\.txt/);
    assert.match(patch, /-before/);
    assert.match(patch, /\+after/);
    assert.equal(readFileSync(join(root, "modified.txt"), "utf8"), "after\n");
  });

  it("exports multiple dirty files in deterministic path order and returns empty patches for clean checkpoints", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const cleanId = await workspace.snapshot();

    assert.equal(await workspace.exportPatch(cleanId), "");

    const dirtyId = await workspace.snapshot();
    writeFileSync(join(root, "zeta.txt"), "z\n");
    writeFileSync(join(root, "alpha.txt"), "a\n");
    const patch = await workspace.exportPatch(dirtyId);

    assert.ok(patch.indexOf("a/alpha.txt") < patch.indexOf("a/zeta.txt"));
  });

  it("throws when exporting modified child-process changes without backup content", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    writeFileSync(join(root, "source.txt"), "before\n");
    const checkpointId = await workspace.snapshot();
    runChildProcessScript(
      root,
      `require('node:fs').writeFileSync(${JSON.stringify(join(root, "source.txt"))}, "after\\n");`,
    );

    await assert.rejects(() => workspace.exportPatch(checkpointId), HyperionIntegrityError);
  });

  it("throws when exporting binary or symlink changes", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const binaryId = await workspace.snapshot();
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2]));

    await assert.rejects(() => workspace.exportPatch(binaryId), HyperionIntegrityError);

    const symlinkId = await workspace.snapshot();
    writeFileSync(join(root, "target.txt"), "target\n");
    try {
      symlinkSync("target.txt", join(root, "target-link.txt"));
    } catch {
      return;
    }

    await assert.rejects(() => workspace.exportPatch(symlinkId), HyperionIntegrityError);
  });

  it("promotes dirty worktree state without reverting or invoking Git ownership", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    writeFileSync(join(root, "modify.txt"), "before\n");
    writeFileSync(join(root, "delete.txt"), "delete me\n");
    writeFileSync(join(root, "rename-source.txt"), "rename me\n");
    writeFileSync(join(root, "copy-source.txt"), "copy me\n");
    const workspace = new HyperionWorkspace(root);
    workspace.installFsInterceptor();
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(join(root, "created.txt"), "created\n");
    fs.writeFileSync(join(root, "modify.txt"), "after\n");
    fs.unlinkSync(join(root, "delete.txt"));
    fs.renameSync(join(root, "rename-source.txt"), join(root, "rename-target.txt"));
    fs.copyFileSync(join(root, "copy-source.txt"), join(root, "copy-target.txt"));
    runChildProcessScript(root, "require('node:fs').writeFileSync('child-created.txt', 'child\\n')");

    const result = await workspace.promote(checkpointId);

    assert.equal(result.checkpointId, checkpointId);
    assert.equal(result.storageCleaned, true);
    assert.equal(result.reconcileResult.created.includes("child-created.txt"), true);
    assert.equal(readFileSync(join(root, "created.txt"), "utf8"), "created\n");
    assert.equal(readFileSync(join(root, "modify.txt"), "utf8"), "after\n");
    assert.equal(existsSync(join(root, "delete.txt")), false);
    assert.equal(existsSync(join(root, "rename-source.txt")), false);
    assert.equal(readFileSync(join(root, "rename-target.txt"), "utf8"), "rename me\n");
    assert.equal(readFileSync(join(root, "copy-target.txt"), "utf8"), "copy me\n");
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.status, "promoted");
    assert.equal(readWorkspaceJournal(root, checkpointId).status, "promoted");
    assert.equal(getActiveCheckpointCount(workspace), 0);
    await assert.rejects(() => workspace.rollback(checkpointId), HyperionRollbackError);
    await assert.rejects(() => workspace.exportPatch(checkpointId), HyperionRollbackError);

    const freshWorkspace = new HyperionWorkspace(root);
    const recovered = (await freshWorkspace.recoverAttempts()).find(
      (attempt) => attempt.checkpointId === checkpointId,
    );

    assert.equal(recovered?.status, "promoted");
    assert.equal(recovered?.canRehydrate, false);
    assert.match(recovered?.nonRehydratableReason ?? "", /promoted/);
    await assert.rejects(() => freshWorkspace.rehydrateAttempt(checkpointId), HyperionRollbackError);
  });

  it("returns a patch before promotion cleanup when requested", async () => {
    const root = createTempWorkspace();
    writeFileSync(join(root, "source.txt"), "before\n");
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      useHotBuffer: false,
    });
    workspace.installFsInterceptor();
    const checkpointId = await workspace.snapshot();

    getCommonJsFs().writeFileSync(join(root, "source.txt"), "after\n");

    const result = await workspace.promote(checkpointId, { exportPatch: true });

    assert.match(result.patch ?? "", /diff --git a\/source\.txt b\/source\.txt/);
    assert.match(result.patch ?? "", /-before/);
    assert.match(result.patch ?? "", /\+after/);
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "after\n");
    await assert.rejects(() => workspace.rollback(checkpointId), HyperionRollbackError);
  });

  it("leaves checkpoints rollback-capable when promotion patch export fails", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    workspace.installFsInterceptor();
    const checkpointId = await workspace.snapshot();

    getCommonJsFs().writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2]));

    await assert.rejects(
      () => workspace.promote(checkpointId, { exportPatch: true }),
      HyperionIntegrityError,
    );

    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.status, "active");
    assert.equal(existsSync(join(root, "binary.bin")), true);

    await workspace.rollback(checkpointId);

    assert.equal(existsSync(join(root, "binary.bin")), false);
  });

  it("cleans tmpfs checkpoint storage and frees capacity after promotion", async () => {
    const root = createTempWorkspace();
    const tmpfsRoot = mkdtempSync(join(tmpdir(), "hyperion-promote-tmpfs-"));
    tempRoots.push(tmpfsRoot);
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      maxConcurrentCheckpoints: 1,
    });
    const checkpointId = await workspace.snapshot();
    const storage = createTmpfsCheckpointStorage(root, tmpfsRoot, checkpointId);
    replaceWorkspaceCheckpointStorage(workspace, checkpointId, storage);
    writeFileSync(join(root, "created.txt"), "created\n");

    const result = await workspace.promote(checkpointId);

    assert.equal(result.storageCleaned, true);
    assert.equal(existsSync(storage.backupNamespace), false);
    assert.equal(getActiveCheckpointCount(workspace), 0);
    await workspace.snapshot();
  });

  it("rejects promoted, unknown, disposed, and rolling-back promotion attempts", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const promotedId = await workspace.snapshot();

    await workspace.promote(promotedId);
    await assert.rejects(() => workspace.promote(promotedId), HyperionRollbackError);
    await assert.rejects(() => workspace.promote("missing-checkpoint"), HyperionRollbackError);

    const disposedId = await workspace.snapshot();
    markWorkspaceCheckpointDisposed(workspace, disposedId);
    await assert.rejects(() => workspace.promote(disposedId), HyperionRollbackError);

    const rollingId = await workspace.snapshot();
    const checkpoint = getWorkspaceCheckpoint(workspace, rollingId);
    assert.ok(checkpoint);
    checkpoint.status = "rolling-back";
    await assert.rejects(() => workspace.promote(rollingId), HyperionRollbackError);
  });

  it("allows declared ignored outputs under strict mode across VFS API families", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      strictIgnoredWrites: true,
    });
    workspace.installFsInterceptor();
    const checkpointId = await workspace.snapshot();
    workspace.declareToolOutputs({
      toolName: "tool-suite",
      checkpointId,
      outputs: [
        "node_modules/pkg/sync.txt",
        "dist/callback.txt",
        ".git/promise.txt",
        ".hyperion/tool-contract/stream.txt",
      ],
    });

    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, ".hyperion", "tool-contract"), { recursive: true });
    fs.writeFileSync(join(root, "node_modules", "pkg", "sync.txt"), "sync\n");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      fs.writeFile(join(root, "dist", "callback.txt"), "callback\n", (error) => {
        if (error) {
          rejectPromise(error);
          return;
        }

        resolvePromise();
      });
    });
    await fs.promises.writeFile(join(root, ".git", "promise.txt"), "promise\n");
    const stream = fs.createWriteStream(join(root, ".hyperion", "tool-contract", "stream.txt"));
    stream.end("stream\n");
    await once(stream, "finish");

    const result = await workspace.reconcile(checkpointId);

    assert.equal(result.created.includes("node_modules/pkg/sync.txt"), true);
    assert.equal(result.created.includes("dist/callback.txt"), true);
    assert.equal(result.created.includes(".git/promise.txt"), true);
    assert.equal(result.created.includes(".hyperion/tool-contract/stream.txt"), true);
    assert.equal(
      getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.get("node_modules/pkg/sync.txt")
        ?.capturedBy,
      "tool-contract",
    );
  });

  it("restores declared ignored outputs modified or deleted through VFS", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "modified.txt"), "before\n");
    writeFileSync(join(root, "node_modules", "pkg", "deleted.txt"), "delete me\n");
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      strictIgnoredWrites: true,
    });
    workspace.declareToolOutputs({
      toolName: "package-manager",
      outputs: [
        "node_modules/pkg/modified.txt",
        "node_modules/pkg/deleted.txt",
      ],
    });
    workspace.installFsInterceptor();
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(join(root, "node_modules", "pkg", "modified.txt"), "after\n");
    fs.unlinkSync(join(root, "node_modules", "pkg", "deleted.txt"));
    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(join(root, "node_modules", "pkg", "modified.txt"), "utf8"), "before\n");
    assert.equal(readFileSync(join(root, "node_modules", "pkg", "deleted.txt"), "utf8"), "delete me\n");
  });

  it("reconciles declared ignored child-process creates without scanning broad ignored roots", async () => {
    const root = createTempWorkspace();
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    workspace.declareToolOutputs({
      toolName: "codegen",
      checkpointId,
      outputs: ["node_modules/pkg/generated.txt"],
    });

    runChildProcessScript(
      root,
      [
        "const fs = require('node:fs');",
        "fs.mkdirSync('node_modules/pkg', { recursive: true });",
        "fs.writeFileSync('node_modules/pkg/generated.txt', 'declared');",
        "fs.writeFileSync('node_modules/pkg/undeclared.txt', 'ignored');",
      ].join(""),
    );

    const result = await workspace.reconcile(checkpointId);

    assert.deepEqual(result.created, ["node_modules/pkg/generated.txt"]);
    await workspace.rollback(checkpointId);
    assert.equal(existsSync(join(root, "node_modules", "pkg", "generated.txt")), false);
    assert.equal(existsSync(join(root, "node_modules", "pkg", "undeclared.txt")), true);
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

  it("marks durable attempt journals disposed after successful rollback and prunes dirty entries", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const checkpointId = await workspace.snapshot();
    writeFileSync(join(root, "created.txt"), "created");

    await workspace.rollback(checkpointId);
    const journal = readWorkspaceJournal(root, checkpointId);

    assert.equal(journal.status, "disposed");
    assert.equal(journal.dirty.some((entry) => entry.relativePath === "created.txt"), false);
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

  it("keeps only unprocessed dirty entries after a partial rollback failure", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);
    const restoredRelativePath = "nested/restored-first.txt";
    const failingRelativePath = "fail.txt";
    const restoredPath = join(root, "nested", "restored-first.txt");
    const failingPath = join(root, "fail.txt");
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(restoredPath, "before-restored");
    writeFileSync(failingPath, "before-failing");
    const checkpointId = await workspace.snapshot();
    backupWorkspaceCheckpointPath(workspace, checkpointId, restoredRelativePath);
    backupWorkspaceCheckpointPath(workspace, checkpointId, failingRelativePath);
    writeFileSync(restoredPath, "after-restored");
    writeFileSync(failingPath, "after-failing");

    const storage = getWorkspaceCheckpointStorage(workspace, checkpointId);
    assert.ok(storage);

    let failOnce = true;
    const wrappedStorage: StorageStrategy = {
      backupFile(pathOrPathLike: string) {
        return storage.backupFile(pathOrPathLike);
      },
      restoreFile(pathOrPathLike: string) {
        if (pathOrPathLike === failingRelativePath && failOnce) {
          failOnce = false;
          throw new Error("injected restore failure");
        }

        return storage.restoreFile(pathOrPathLike);
      },
      deleteCreatedPath(pathOrPathLike: string) {
        storage.deleteCreatedPath(pathOrPathLike);
      },
      getBackupRecord(pathOrPathLike: string) {
        return storage.getBackupRecord(pathOrPathLike);
      },
      getBackupRecords() {
        return storage.getBackupRecords();
      },
      readBackupFile(pathOrPathLike: string) {
        return storage.readBackupFile(pathOrPathLike);
      },
      getDiagnostics() {
        return storage.getDiagnostics();
      },
      hydrateBackupRecords(records) {
        storage.hydrateBackupRecords?.(records);
      },
      cleanup() {
        storage.cleanup?.();
      },
    };
    replaceWorkspaceCheckpointStorage(workspace, checkpointId, wrappedStorage);

    await assert.rejects(() => workspace.rollback(checkpointId), /injected restore failure/);

    const checkpointAfterFailure = getWorkspaceCheckpoint(workspace, checkpointId);
    assert.equal(checkpointAfterFailure?.status, "active");
    assert.equal(checkpointAfterFailure?.dirty.has(restoredRelativePath), false);
    assert.equal(checkpointAfterFailure?.dirty.has(failingRelativePath), true);
    assert.equal(readFileSync(restoredPath, "utf8"), "before-restored");
    assert.equal(readFileSync(failingPath, "utf8"), "after-failing");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(failingPath, "utf8"), "before-failing");
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.status, "disposed");
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
    assert.equal(readWorkspaceJournal(root, checkpointId).status, "active");
  });

  it("calls reconcile before rollback and clears dirty entries after rollback", async () => {
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
    assert.equal(getWorkspaceCheckpoint(workspace, checkpointId)?.dirty.has("created.txt"), false);
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
