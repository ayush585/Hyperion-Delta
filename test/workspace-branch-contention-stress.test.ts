import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  HyperionBranchConflictError,
  HyperionWorkspace,
  type Checkpoint,
  type CheckpointId,
} from "../src/index.js";

const tempRoots: string[] = [];
const activeWorkspaces: HyperionWorkspace[] = [];

function createTempWorkspaceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-branch-stress-"));
  tempRoots.push(root);
  return root;
}

function createWorkspace(root: string): HyperionWorkspace {
  const workspace = new HyperionWorkspace(root);
  activeWorkspaces.push(workspace);
  return workspace;
}

function readEnvInteger(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCheckpoint(workspace: HyperionWorkspace, checkpointId: CheckpointId): Checkpoint | undefined {
  return (
    workspace as unknown as {
      checkpointStore: {
        getCheckpoint(checkpointId: CheckpointId): Checkpoint | undefined;
      };
    }
  ).checkpointStore.getCheckpoint(checkpointId);
}

function setCreatedDirtyEntry(
  workspace: HyperionWorkspace,
  checkpointId: CheckpointId,
  relativePath: string,
): void {
  const checkpoint = getCheckpoint(workspace, checkpointId);

  if (!checkpoint) {
    throw new Error(`Unknown checkpoint for stress helper: ${checkpointId}`);
  }

  const now = Date.now();
  checkpoint.dirty.set(relativePath, {
    relativePath,
    kind: "created",
    fileType: "file",
    capturedBy: "reconcile",
    firstSeenAt: now,
    lastSeenAt: now,
  });
}

afterEach(async () => {
  while (activeWorkspaces.length > 0) {
    await activeWorkspaces.pop()?.dispose();
  }

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();

    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("workspace branch contention stress", () => {
  it("keeps branch invariants under parallel subagent promote/drop contention", async () => {
    const cycleCount = readEnvInteger("HYPERION_BRANCH_STRESS_CYCLES", 20);
    const subagentCount = Math.max(2, readEnvInteger("HYPERION_BRANCH_SUBAGENTS", 4));

    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      const root = createTempWorkspaceRoot();
      const workspace = createWorkspace(root);
      const baseCheckpointId = await workspace.snapshot({ branchId: "main", agentId: "lead" });
      const branchIds: string[] = [];

      for (let index = 0; index < subagentCount; index += 1) {
        const branchId = await workspace.fork(baseCheckpointId, {
          branchId: `cycle-${cycle}-agent-${index}`,
          agentId: `agent-${index}`,
        });
        branchIds.push(branchId);

        const relativePath = `cycle-${cycle}-agent-${index}.txt`;
        writeFileSync(path.join(root, relativePath), `agent-${index}\n`);
        setCreatedDirtyEntry(workspace, branchId, relativePath);
      }

      const overlappingPath = `cycle-${cycle}-shared.txt`;
      writeFileSync(path.join(root, overlappingPath), "shared\n");
      const firstBranchId = branchIds[0];
      const secondBranchId = branchIds[1];

      assert.ok(firstBranchId);
      assert.ok(secondBranchId);
      setCreatedDirtyEntry(workspace, firstBranchId, overlappingPath);
      setCreatedDirtyEntry(workspace, secondBranchId, overlappingPath);

      const promotionResults = await Promise.allSettled(
        branchIds.map((branchCheckpointId) =>
          workspace.promoteBranch(branchCheckpointId, { conflictMode: "reject" }),
        ),
      );

      const conflictedBranches: string[] = [];

      for (let index = 0; index < promotionResults.length; index += 1) {
        const result = promotionResults[index];
        const branchCheckpointId = branchIds[index];

        if (!branchCheckpointId) {
          continue;
        }

        if (result?.status === "fulfilled") {
          continue;
        }

        assert.equal(result?.reason instanceof HyperionBranchConflictError, true);
        conflictedBranches.push(branchCheckpointId);
      }

      assert.equal(conflictedBranches.length >= 1, true);

      const conflictedBranchId = conflictedBranches[0];
      if (conflictedBranchId) {
        const rollbackResult = await Promise.allSettled([
          workspace.rollback(conflictedBranchId),
        ]);
        const rollbackOutcome = rollbackResult[0];

        if (rollbackOutcome?.status === "rejected") {
          assert.equal(rollbackOutcome.reason instanceof HyperionBranchConflictError, true);
        }
      }

      const conflictedDropId = conflictedBranches.find((checkpointId) => checkpointId !== conflictedBranchId);
      if (conflictedDropId) {
        const dropResult = await Promise.allSettled([workspace.dropBranch(conflictedDropId)]);
        const dropOutcome = dropResult[0];

        if (dropOutcome?.status === "rejected") {
          assert.equal(dropOutcome.reason instanceof HyperionBranchConflictError, true);
        }
      }

      await workspace.dispose();
    }
  });
});
