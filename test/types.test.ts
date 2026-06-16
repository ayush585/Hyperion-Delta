import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_HOT_BUFFER_MAX_FILE_BYTES,
  DEFAULT_HOT_BUFFER_MAX_FILES,
  DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES,
  DEFAULT_IGNORED_PATTERNS,
  HyperionAgentSession,
  HyperionExecError,
  HyperionError,
  HyperionIgnoredPathError,
  HyperionWorkspace,
  type Checkpoint,
  type CheckpointId,
  type DirtyEntry,
  type HyperionAgentSessionDiagnostics,
  type HyperionAttemptOptions,
  type HyperionAttemptResult,
  type HyperionConfig,
  type HyperionExecOptions,
  type HyperionExecResult,
  type HyperionPromoteOptions,
  type HyperionPromotionResult,
  type RecoverableAttempt,
  type ReconcileResult,
  type StateManifest,
  type StorageStrategyKind,
} from "../src/index.js";

describe("package exports", () => {
  it("exports the public runtime API", () => {
    assert.equal(typeof HyperionWorkspace, "function");
    assert.equal(typeof HyperionAgentSession, "function");
    assert.equal(typeof HyperionError, "function");
    assert.equal(typeof HyperionExecError, "function");
    assert.equal(typeof HyperionIgnoredPathError, "function");
    assert.equal(typeof DEFAULT_HOT_BUFFER_MAX_FILE_BYTES, "number");
    assert.equal(typeof DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES, "number");
    assert.equal(typeof DEFAULT_HOT_BUFFER_MAX_FILES, "number");
    assert.ok(DEFAULT_IGNORED_PATTERNS.includes("node_modules/**"));
  });

  it("exports public type contracts", () => {
    const checkpointId: CheckpointId = "checkpoint";
    const config: HyperionConfig = {
      workspaceRoot: process.cwd(),
      useHotBuffer: true,
      hotBufferMaxFileBytes: DEFAULT_HOT_BUFFER_MAX_FILE_BYTES,
      hotBufferMaxTotalBytes: DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES,
      hotBufferMaxFiles: DEFAULT_HOT_BUFFER_MAX_FILES,
      strictIgnoredWrites: true,
      durableAttemptJournals: true,
    };
    const strategy: StorageStrategyKind = "pure-manifest";
    const reconcileResult: ReconcileResult = {
      checkpointId,
      created: [],
      modified: [],
      deleted: [],
      renamed: [],
    };
    const manifest: StateManifest = {
      gitAvailable: false,
      gitIndexEntries: new Map(),
      statEntries: new Map(),
      ignoredPatterns: [],
      capturedAt: Date.now(),
    };
    const dirtyEntry: DirtyEntry = {
      relativePath: "src/index.ts",
      kind: "modified",
      fileType: "file",
      capturedBy: "track",
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    const checkpoint: Checkpoint = {
      id: checkpointId,
      baseline: manifest,
      dirty: new Map([[dirtyEntry.relativePath, dirtyEntry]]),
      storageNamespace: ".hyperion/checkpoints/checkpoint",
      status: "active",
      createdAt: Date.now(),
    };
    const diagnostics: HyperionAgentSessionDiagnostics = {
      strategy,
      lastReconcileResult: reconcileResult,
      isDisposed: false,
    };
    const attemptOptions: HyperionAttemptOptions = { rollbackOnThrow: true };
    const promoteOptions: HyperionPromoteOptions = { exportPatch: true };
    const execOptions: HyperionExecOptions = { captureOutput: true };
    const execResult: HyperionExecResult = {
      command: "node",
      args: ["--version"],
      exitCode: 0,
      signal: null,
    };
    const attemptResult: HyperionAttemptResult<number> = {
      checkpointId,
      result: 1,
      rolledBack: false,
    };
    const promotionResult: HyperionPromotionResult = {
      checkpointId,
      promotedAt: 3,
      dirtyCount: 1,
      reconcileResult,
      storageCleaned: true,
      patch: "diff --git a/file b/file\n",
    };
    const recoverableAttempt: RecoverableAttempt = {
      checkpointId,
      sessionId: "session",
      createdAt: 1,
      updatedAt: 2,
      status: "active",
      strategy,
      dirtyCount: 0,
      journalPath: "/tmp/journal.json",
      canRehydrate: true,
    };

    assert.equal(config.workspaceRoot, process.cwd());
    assert.equal(config.useHotBuffer, true);
    assert.equal(config.strictIgnoredWrites, true);
    assert.equal(config.durableAttemptJournals, true);
    assert.equal(strategy, "pure-manifest");
    assert.equal(reconcileResult.checkpointId, checkpointId);
    assert.equal(checkpoint.id, checkpointId);
    assert.equal(diagnostics.lastReconcileResult?.checkpointId, checkpointId);
    assert.equal(attemptOptions.rollbackOnThrow, true);
    assert.equal(promoteOptions.exportPatch, true);
    assert.equal(execOptions.captureOutput, true);
    assert.equal(execResult.exitCode, 0);
    assert.equal(attemptResult.result, 1);
    assert.equal(promotionResult.storageCleaned, true);
    assert.equal(recoverableAttempt.checkpointId, checkpointId);
    assert.equal(typeof HyperionWorkspace.prototype.exportPatch, "function");
    assert.equal(typeof HyperionAgentSession.prototype.exportPatch, "function");
    assert.equal(typeof HyperionWorkspace.prototype.promote, "function");
    assert.equal(typeof HyperionAgentSession.prototype.promote, "function");
    assert.equal(typeof HyperionWorkspace.prototype.rehydrateAttempt, "function");
    assert.equal(typeof HyperionAgentSession.prototype.rehydrateAttempt, "function");
  });
});
