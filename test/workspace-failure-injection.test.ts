import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  HyperionIntegrityError,
  HyperionRollbackError,
  HyperionWorkspace,
  type StateManifest,
} from "../src/index.js";

const tempRoots: string[] = [];
const activeWorkspaces: HyperionWorkspace[] = [];

function createTempWorkspaceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-failure-injection-"));
  tempRoots.push(root);
  return root;
}

function createWorkspace(root: string, enableFsInterceptor = true): HyperionWorkspace {
  const workspace = new HyperionWorkspace({ workspaceRoot: root, enableFsInterceptor });

  if (enableFsInterceptor) {
    workspace.installFsInterceptor();
  }

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

describe("workspace failure injection", () => {
  it("wraps ENOSPC snapshot capture failures with operation context", async () => {
    const root = createTempWorkspaceRoot();
    const workspace = createWorkspace(root);
    const injectedError = Object.assign(new Error("manifest capture ENOSPC"), {
      code: "ENOSPC",
      syscall: "open",
      path: path.join(root, "state.json"),
    });

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
        assert.match((error as Error).message, /snapshot\(\) failed: manifest capture ENOSPC/);
        assert.equal((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code, "ENOSPC");
        return true;
      },
    );
  });

  it("wraps journal access failures during rehydrateAttempt", async () => {
    const root = createTempWorkspaceRoot();
    const workspace = createWorkspace(root);
    const injectedError = Object.assign(new Error("journal read denied"), {
      code: "EACCES",
      syscall: "open",
    });

    (
      workspace as unknown as {
        attemptJournalStore: {
          read(checkpointId: string): unknown;
        };
      }
    ).attemptJournalStore.read = () => {
      throw injectedError;
    };

    await assert.rejects(
      () => workspace.rehydrateAttempt("checkpoint-missing"),
      (error) => {
        assert.equal(error instanceof HyperionRollbackError, true);
        assert.match((error as Error).message, /rehydrateAttempt\(\) failed: journal read denied/);
        assert.equal((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code, "EACCES");
        return true;
      },
    );
  });

  it("preserves typed integrity failures during rollback", async () => {
    const root = createTempWorkspaceRoot();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root, false);
    const checkpointId = await workspace.snapshot();

    writeFileSync(sourcePath, "mutated");

    await assert.rejects(
      () => workspace.rollback(checkpointId),
      (error) => {
        assert.equal(error instanceof HyperionIntegrityError, true);
        assert.match((error as Error).message, /Missing backup record/);
        return true;
      },
    );

    assert.equal(readFileSync(sourcePath, "utf8"), "mutated");
  });
});
