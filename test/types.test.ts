import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_HOT_BUFFER_MAX_FILE_BYTES,
  DEFAULT_HOT_BUFFER_MAX_FILES,
  DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES,
  DEFAULT_IGNORED_PATTERNS,
  HyperionAgentSession,
  HyperionBranchConflictError,
  HyperionAttemptContextError,
  HyperionAttemptInProgressError,
  HyperionExecError,
  HyperionExecOptionsError,
  HyperionExecTimeoutError,
  HyperionError,
  HyperionIgnoredPathError,
  HyperionWorkspace,
  type Checkpoint,
  type CheckpointId,
  type DirtyEntry,
  type HyperionBranchConflictMode,
  type HyperionBranchContext,
  type HyperionBranchMergeResult,
  type HyperionBranchPathConflict,
  type HyperionBranchPromotionResult,
  type HyperionBranchRunResult,
  type HyperionAgentSessionDiagnostics,
  type HyperionAgentSessionErrorCode,
  type HyperionAttemptOptions,
  type HyperionAttemptResult,
  type HyperionCheckpointCreatedBy,
  type HyperionCheckpointHeadFilter,
  type HyperionCheckpointDiagnostics,
  type HyperionCheckpointSummary,
  type HyperionConfig,
  type HyperionDiagnostics,
  type HyperionExecOptions,
  type HyperionExecResult,
  type HyperionHotBufferDiagnostics,
  type HyperionIgnoredWriteEvent,
  type HyperionPromoteBranchOptions,
  type HyperionPromoteOptions,
  type HyperionPromotionResult,
  type HyperionSnapshotOptions,
  type HyperionStorageDiagnostics,
  type HyperionToolOutputContract,
  type HyperionToolOutputPath,
  type HyperionWindowsVolumeDiagnostics,
  type RecoverableAttempt,
  type ReconcileResult,
  type StateManifest,
  type StorageStrategyKind,
  type VfsMutationKind,
} from "../src/index.js";

describe("package exports", () => {
  it("exports the public runtime API", () => {
    assert.equal(typeof HyperionWorkspace, "function");
    assert.equal(typeof HyperionAgentSession, "function");
    assert.equal(typeof HyperionError, "function");
    assert.equal(typeof HyperionExecError, "function");
    assert.equal(typeof HyperionExecTimeoutError, "function");
    assert.equal(typeof HyperionExecOptionsError, "function");
    assert.equal(typeof HyperionAttemptContextError, "function");
    assert.equal(typeof HyperionAttemptInProgressError, "function");
    assert.equal(typeof HyperionBranchConflictError, "function");
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
    const snapshotOptions: HyperionSnapshotOptions = {
      parentId: checkpointId,
      branchId: "branch-a",
      subagentId: "planner",
      agentId: "agent-planner",
      createdBy: "run-attempt",
    };
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
      parentId: checkpointId,
      branchId: "branch-a",
      subagentId: "planner",
      agentId: "agent-planner",
      createdBy: "snapshot",
      baseline: manifest,
      dirty: new Map([[dirtyEntry.relativePath, dirtyEntry]]),
      storageNamespace: ".hyperion/checkpoints/checkpoint",
      status: "active",
      createdAt: Date.now(),
    };
    const hotBufferDiagnostics: HyperionHotBufferDiagnostics = {
      enabled: true,
      memoryHits: 1,
      spills: 0,
      bytesUsed: 4,
      filesUsed: 1,
    };
    const storageDiagnostics: HyperionStorageDiagnostics = {
      physicalStrategy: strategy,
      backupRecordCount: 1,
      hotBuffer: hotBufferDiagnostics,
      ntfsLink: {
        linkModeActive: false,
      },
    };
    const windowsVolumeDiagnostics: HyperionWindowsVolumeDiagnostics = {
      fileSystemName: "NTFS",
      isDevDrive: false,
      devDriveTrusted: false,
      hardLinkCapable: true,
      blockCloneCandidate: false,
    };
    const ignoredMutationKind: VfsMutationKind = "write";
    const ignoredWriteEvent: HyperionIgnoredWriteEvent = {
      relativePath: "node_modules/pkg/cache.json",
      kind: ignoredMutationKind,
      capturedAt: 1,
      action: "declared",
    };
    const checkpointDiagnostics: HyperionCheckpointDiagnostics = {
      checkpointId,
      parentId: checkpointId,
      branchId: "branch-a",
      subagentId: "planner",
      agentId: "agent-planner",
      createdBy: "snapshot",
      createdAt: 1,
      status: "active",
      lineage: [
        {
          checkpointId,
          branchId: "branch-a",
          subagentId: "planner",
          agentId: "agent-planner",
          createdBy: "snapshot",
          status: "active",
          createdAt: 1,
          source: "active",
        },
      ],
      storage: storageDiagnostics,
    };
    const checkpointSummary: HyperionCheckpointSummary = {
      checkpointId,
      parentId: checkpointId,
      branchId: "branch-a",
      subagentId: "planner",
      agentId: "agent-planner",
      createdBy: "snapshot",
      status: "active",
      createdAt: 1,
      source: "active",
    };
    const checkpointHeadFilter: HyperionCheckpointHeadFilter = {
      branchId: "branch-a",
      subagentId: "planner",
      agentId: "agent-planner",
      includeInactive: true,
    };
    const checkpointCreatedBy: HyperionCheckpointCreatedBy = "run-in-branch";
    const branchConflictMode: HyperionBranchConflictMode = "reject";
    const branchPathConflict: HyperionBranchPathConflict = {
      relativePath: "src/index.ts",
      sourceCheckpointId: checkpointId,
      targetCheckpointId: "target-checkpoint",
      sourceKind: "modified",
      targetKind: "deleted",
      sourceAgentId: "agent-a",
      targetAgentId: "agent-b",
    };
    const branchMergeResult: HyperionBranchMergeResult = {
      sourceCheckpointId: checkpointId,
      targetCheckpointId: "target-checkpoint",
      conflictMode: branchConflictMode,
      mergedAt: 1,
      appliedPaths: ["src/ok.ts"],
      conflicts: [branchPathConflict],
    };
    const promoteBranchOptions: HyperionPromoteBranchOptions = {
      conflictMode: branchConflictMode,
      targetCheckpointId: "target-checkpoint",
      exportPatch: true,
    };
    const branchPromotionResult: HyperionBranchPromotionResult = {
      checkpointId,
      promotedAt: 2,
      dirtyCount: 1,
      reconcileResult,
      storageCleaned: true,
      merge: branchMergeResult,
    };
    const branchContext: HyperionBranchContext = {
      checkpointId,
      workspace: {} as HyperionWorkspace,
      reconcile: async () => reconcileResult,
    };
    const branchRunResult: HyperionBranchRunResult<string> = {
      checkpointId,
      result: "ok",
      reconcileResult,
    };
    const workspaceDiagnostics: HyperionDiagnostics = {
      strategy,
      activeCheckpointCount: 1,
      checkpoints: [checkpointDiagnostics],
      ignoredWrites: [ignoredWriteEvent],
      isDisposed: false,
      windowsVolume: windowsVolumeDiagnostics,
    };
    const diagnostics: HyperionAgentSessionDiagnostics = {
      ...workspaceDiagnostics,
      lastReconcileResult: reconcileResult,
      lastRollbackMs: 1,
    };
    const sessionErrorCode: HyperionAgentSessionErrorCode = "HYPERION_EXEC_TIMEOUT";
    const attemptOptions: HyperionAttemptOptions = { rollbackOnThrow: true };
    const promoteOptions: HyperionPromoteOptions = { exportPatch: true };
    const toolOutputPath: HyperionToolOutputPath = {
      path: "dist/generated.js",
      optional: true,
    };
    const toolOutputContract: HyperionToolOutputContract = {
      toolName: "codegen",
      checkpointId,
      outputs: [toolOutputPath, "node_modules/.cache/tool.json"],
    };
    const execOptions: HyperionExecOptions = { captureOutput: true, timeoutMs: 1_000 };
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
      parentId: checkpointId,
      branchId: "branch-a",
      subagentId: "planner",
      agentId: "agent-planner",
      createdBy: "snapshot",
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
    assert.equal(snapshotOptions.parentId, checkpointId);
    assert.equal(snapshotOptions.agentId, "agent-planner");
    assert.equal(snapshotOptions.createdBy, "run-attempt");
    assert.equal(reconcileResult.checkpointId, checkpointId);
    assert.equal(checkpoint.id, checkpointId);
    assert.equal(workspaceDiagnostics.checkpoints[0]?.checkpointId, checkpointId);
    assert.equal(checkpointSummary.branchId, "branch-a");
    assert.equal(checkpointSummary.agentId, "agent-planner");
    assert.equal(checkpointHeadFilter.includeInactive, true);
    assert.equal(checkpointCreatedBy, "run-in-branch");
    assert.equal(branchPathConflict.targetKind, "deleted");
    assert.equal(branchMergeResult.conflictMode, "reject");
    assert.equal(promoteBranchOptions.exportPatch, true);
    assert.equal(branchPromotionResult.merge.conflicts.length, 1);
    assert.equal(branchContext.checkpointId, checkpointId);
    assert.equal(branchRunResult.result, "ok");
    assert.equal(storageDiagnostics.hotBuffer.memoryHits, 1);
    assert.equal(storageDiagnostics.ntfsLink?.linkModeActive, false);
    assert.equal(workspaceDiagnostics.windowsVolume?.hardLinkCapable, true);
    assert.equal(ignoredWriteEvent.action, "declared");
    assert.equal(diagnostics.lastReconcileResult?.checkpointId, checkpointId);
    assert.equal(sessionErrorCode, "HYPERION_EXEC_TIMEOUT");
    assert.equal(attemptOptions.rollbackOnThrow, true);
    assert.equal(promoteOptions.exportPatch, true);
    assert.equal(toolOutputContract.outputs.length, 2);
    assert.equal(execOptions.captureOutput, true);
    assert.equal(execOptions.timeoutMs, 1_000);
    assert.equal(ignoredMutationKind, "write");
    assert.equal(execResult.exitCode, 0);
    assert.equal(attemptResult.result, 1);
    assert.equal(promotionResult.storageCleaned, true);
    assert.equal(recoverableAttempt.checkpointId, checkpointId);
    assert.equal(typeof HyperionWorkspace.prototype.exportPatch, "function");
    assert.equal(typeof HyperionAgentSession.prototype.exportPatch, "function");
    assert.equal(typeof HyperionWorkspace.prototype.fork, "function");
    assert.equal(typeof HyperionAgentSession.prototype.fork, "function");
    assert.equal(typeof HyperionWorkspace.prototype.runInBranch, "function");
    assert.equal(typeof HyperionAgentSession.prototype.runInBranch, "function");
    assert.equal(typeof HyperionWorkspace.prototype.promoteBranch, "function");
    assert.equal(typeof HyperionAgentSession.prototype.promoteBranch, "function");
    assert.equal(typeof HyperionWorkspace.prototype.dropBranch, "function");
    assert.equal(typeof HyperionAgentSession.prototype.dropBranch, "function");
    assert.equal(typeof HyperionWorkspace.prototype.promote, "function");
    assert.equal(typeof HyperionAgentSession.prototype.promote, "function");
    assert.equal(typeof HyperionWorkspace.prototype.getCheckpointLineage, "function");
    assert.equal(typeof HyperionAgentSession.prototype.getCheckpointLineage, "function");
    assert.equal(typeof HyperionWorkspace.prototype.listCheckpointChildren, "function");
    assert.equal(typeof HyperionAgentSession.prototype.listCheckpointChildren, "function");
    assert.equal(typeof HyperionWorkspace.prototype.listBranchHeads, "function");
    assert.equal(typeof HyperionAgentSession.prototype.listBranchHeads, "function");
    assert.equal(typeof HyperionWorkspace.prototype.listSubagentHeads, "function");
    assert.equal(typeof HyperionAgentSession.prototype.listSubagentHeads, "function");
    assert.equal(typeof HyperionWorkspace.prototype.declareToolOutputs, "function");
    assert.equal(typeof HyperionAgentSession.prototype.declareToolOutputs, "function");
    assert.equal(typeof HyperionWorkspace.prototype.getDiagnostics, "function");
    assert.equal(typeof HyperionAgentSession.prototype.getDiagnostics, "function");
    assert.equal(typeof HyperionWorkspace.prototype.rehydrateAttempt, "function");
    assert.equal(typeof HyperionAgentSession.prototype.rehydrateAttempt, "function");
  });
});
