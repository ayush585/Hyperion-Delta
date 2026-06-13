import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_IGNORED_PATTERNS,
  HyperionError,
  HyperionWorkspace,
  type Checkpoint,
  type CheckpointId,
  type DirtyEntry,
  type HyperionConfig,
  type ReconcileResult,
  type StateManifest,
  type StorageStrategyKind,
} from "../src/index.js";

describe("package exports", () => {
  it("exports the public runtime API", () => {
    assert.equal(typeof HyperionWorkspace, "function");
    assert.equal(typeof HyperionError, "function");
    assert.ok(DEFAULT_IGNORED_PATTERNS.includes("node_modules/**"));
  });

  it("exports public type contracts", () => {
    const checkpointId: CheckpointId = "checkpoint";
    const config: HyperionConfig = { workspaceRoot: process.cwd() };
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

    assert.equal(config.workspaceRoot, process.cwd());
    assert.equal(strategy, "pure-manifest");
    assert.equal(reconcileResult.checkpointId, checkpointId);
    assert.equal(checkpoint.id, checkpointId);
  });
});
