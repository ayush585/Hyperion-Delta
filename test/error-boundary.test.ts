import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { HyperionRollbackError, HyperionWorkspace, type StateManifest } from "../src/index.js";

const tempRoots: string[] = [];
const activeWorkspaces: HyperionWorkspace[] = [];

function createTempWorkspaceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-error-boundary-"));
  tempRoots.push(root);
  return root;
}

function createWorkspace(root: string): HyperionWorkspace {
  const workspace = new HyperionWorkspace(root);
  activeWorkspaces.push(workspace);
  return workspace;
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

describe("workspace error boundaries", () => {
  it("wraps unknown snapshot failures in HyperionRollbackError", async () => {
    const root = createTempWorkspaceRoot();
    const workspace = createWorkspace(root);
    const injectedError = Object.assign(new Error("capture manifest failed"), { code: "ENOSPC" });

    (
      workspace as unknown as {
        stateEngine: {
          captureManifest(): StateManifest;
        };
      }
    ).stateEngine.captureManifest = () => {
      throw injectedError;
    };

    await assert.rejects(
      () => workspace.snapshot(),
      (error) => {
        assert.equal(error instanceof HyperionRollbackError, true);
        assert.match((error as Error).message, /snapshot\(\) failed: capture manifest failed/);
        assert.equal((error as Error & { cause?: unknown }).cause, injectedError);
        return true;
      },
    );
  });

  it("wraps unknown reconcile failures in HyperionRollbackError", async () => {
    const root = createTempWorkspaceRoot();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const injectedError = new Error("reconcile capture exploded");

    (
      workspace as unknown as {
        stateEngine: {
          captureManifest(): StateManifest;
        };
      }
    ).stateEngine.captureManifest = () => {
      throw injectedError;
    };

    await assert.rejects(
      () => workspace.reconcile(checkpointId),
      (error) => {
        assert.equal(error instanceof HyperionRollbackError, true);
        assert.match((error as Error).message, /reconcile\(\) failed: reconcile capture exploded/);
        assert.equal((error as Error & { cause?: unknown }).cause, injectedError);
        return true;
      },
    );
  });

  it("wraps unknown rollback engine failures and keeps checkpoint active", async () => {
    const root = createTempWorkspaceRoot();
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();
    const injectedError = new Error("restore pipeline panic");

    (
      workspace as unknown as {
        rollbackEngine: {
          rollback(): Promise<void>;
        };
      }
    ).rollbackEngine.rollback = async () => {
      throw injectedError;
    };

    await assert.rejects(
      () => workspace.rollback(checkpointId),
      (error) => {
        assert.equal(error instanceof HyperionRollbackError, true);
        assert.match((error as Error).message, /rollback\(\) failed: restore pipeline panic/);
        assert.equal((error as Error & { cause?: unknown }).cause, injectedError);
        return true;
      },
    );

    assert.equal(workspace.getDiagnostics().activeCheckpointCount, 1);
  });
});
