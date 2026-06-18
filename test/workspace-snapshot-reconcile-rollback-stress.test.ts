import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { HyperionWorkspace } from "../src/index.js";

const require = createRequire(import.meta.url);
const tempRoots: string[] = [];
const activeWorkspaces: HyperionWorkspace[] = [];

function getCommonJsFs(): typeof import("node:fs") {
  return require("node:fs") as typeof import("node:fs");
}

function createTempWorkspaceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-stress-"));
  tempRoots.push(root);
  return root;
}

function createWorkspace(root: string): HyperionWorkspace {
  const workspace = new HyperionWorkspace(root);
  workspace.installFsInterceptor();
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

describe("workspace snapshot/reconcile/rollback stress", () => {
  it("keeps checkpoint and file invariants across concurrent attempt loops", async () => {
    const cycleCount = readEnvInteger("HYPERION_STRESS_CYCLES", 30);
    const concurrency = readEnvInteger("HYPERION_STRESS_CONCURRENCY", 4);
    const fs = getCommonJsFs();
    const workerContexts = [...new Array(concurrency)].map((_, workerIndex) => {
      const root = createTempWorkspaceRoot();
      const workspace = createWorkspace(root);
      const workerFile = path.join(root, "worker.txt");
      writeFileSync(workerFile, `base-${workerIndex}\n`);
      return { workerIndex, root, workspace, workerFile };
    });

    await Promise.all(workerContexts.map(async ({ workerIndex, root, workspace, workerFile }) => {
        for (let cycle = 0; cycle < cycleCount; cycle += 1) {
          const checkpointId = await workspace.snapshot();
          const tempFile = path.join(root, `worker-${workerIndex}-cycle-${cycle}.tmp`);

          fs.writeFileSync(workerFile, `worker=${workerIndex};cycle=${cycle}\n`);
          fs.writeFileSync(tempFile, "temp\n");
          await workspace.reconcile(checkpointId);
          await workspace.rollback(checkpointId);

          assert.equal(readFileSync(workerFile, "utf8"), `base-${workerIndex}\n`);
        }
      }),
    );

    for (const { workerIndex, workspace, workerFile } of workerContexts) {
      assert.equal(readFileSync(workerFile, "utf8"), `base-${workerIndex}\n`);
      const diagnostics = workspace.getDiagnostics();
      assert.equal(diagnostics.activeCheckpointCount, 0);
      assert.equal(diagnostics.checkpoints.filter((checkpoint) => checkpoint.status === "active").length, 0);
    }
  });
});
