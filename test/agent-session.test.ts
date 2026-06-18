import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  HyperionAgentSession,
  HyperionAttemptContextError,
  HyperionAttemptInProgressError,
  HyperionExecError,
  HyperionExecOptionsError,
  HyperionExecTimeoutError,
  type HyperionAgentSessionDiagnostics,
  type HyperionAttemptContext,
  type HyperionAttemptOptions,
  type HyperionAttemptResult,
  type CheckpointId,
  type HyperionExecOptions,
  type HyperionExecResult,
  type ReconcileResult,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const tempRoots: string[] = [];
const activeSessions: HyperionAgentSession[] = [];

function getCommonJsFs(): typeof import("node:fs") {
  return require("node:fs") as typeof import("node:fs");
}

function createTempWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-agent-session-"));
  tempRoots.push(root);
  return root;
}

function createSession(root: string, enableFsInterceptor = true): HyperionAgentSession {
  const session = new HyperionAgentSession({
    workspaceRoot: root,
    enableFsInterceptor,
  });
  activeSessions.push(session);
  return session;
}

function runNodeMutation(root: string, script: string): void {
  execFileSync(process.execPath, ["-e", script], { cwd: root, stdio: "ignore" });
}

afterEach(async () => {
  while (activeSessions.length > 0) {
    const session = activeSessions.pop();
    await session?.dispose();
  }

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("HyperionAgentSession", () => {
  it("creates a workspace and installs fs interception by default", () => {
    const root = createTempWorkspace();
    const session = createSession(root);

    assert.equal(session.workspace.root, path.resolve(root));
    assert.equal(session.workspace.isFsInterceptorInstalled, true);
    assert.ok(["tmpfs", "posix-link", "ntfs-link", "pure-manifest"].includes(session.strategy));
  });

  it("returns checkpoint IDs through the wrapper snapshot method", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const checkpointId = await session.snapshot();

    assert.equal(typeof checkpointId, "string");
    assert.notEqual(checkpointId.length, 0);
  });

  it("delegates fork and lineage/head helpers to the workspace", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const parentId = await session.snapshot({
      branchId: "branch-a",
      subagentId: "planner",
    });
    const childId = await session.fork(parentId);
    const reviewerId = await session.fork(parentId, { subagentId: "reviewer" });

    const lineage = session.getCheckpointLineage(childId);
    const children = session.listCheckpointChildren(parentId);
    const branchHeads = session.listBranchHeads({ branchId: "branch-a" });
    const subagentHeads = session.listSubagentHeads({ branchId: "branch-a" });

    assert.deepEqual(lineage.map((summary) => summary.checkpointId), [parentId, childId]);
    assert.deepEqual(children.map((summary) => summary.checkpointId), [childId, reviewerId]);
    assert.equal(branchHeads[0]?.checkpointId, reviewerId);
    assert.equal(
      subagentHeads.find((summary) => summary.subagentId === "planner")?.checkpointId,
      childId,
    );
    assert.equal(
      subagentHeads.find((summary) => summary.subagentId === "reviewer")?.checkpointId,
      reviewerId,
    );
  });

  it("delegates runInBranch(), promoteBranch(), and dropBranch()", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const mainId = await session.snapshot({ branchId: "main", agentId: "lead" });
    const featureId = await session.fork(mainId, {
      branchId: "feature-a",
      agentId: "agent-a",
    });

    const runResult = await session.runInBranch(featureId, async () => {
      writeFileSync(path.join(root, "feature-created.txt"), "created");
      return "done";
    });

    assert.equal(runResult.result, "done");
    assert.equal(runResult.reconcileResult.created.includes("feature-created.txt"), true);

    const promoteResult = await session.promoteBranch(featureId, { conflictMode: "reject" });

    assert.equal(promoteResult.checkpointId, featureId);
    assert.equal(promoteResult.merge.conflicts.length, 0);
    assert.equal(promoteResult.merge.appliedPaths.includes("feature-created.txt"), true);

    const scratchId = await session.snapshot({ branchId: "scratch", agentId: "agent-drop" });
    await session.runInBranch(scratchId, async () => {
      writeFileSync(path.join(root, "scratch-created.txt"), "created");
    });
    await session.dropBranch(scratchId);

    assert.equal(existsSync(path.join(root, "scratch-created.txt")), false);
  });

  it("rolls back a VFS-backed failed attempt", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const session = createSession(root);
    const checkpointId = await session.snapshot();

    fs.writeFileSync(sourcePath, "mutated");
    fs.writeFileSync(path.join(root, "created.txt"), "created");
    await session.rollback(checkpointId);

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
    assert.equal(existsSync(path.join(root, "created.txt")), false);
    assert.equal(typeof session.lastRollbackMs, "number");
    assert.ok((session.lastRollbackMs ?? 0) >= 0);
  });

  it("rolls back child-process-created files through the rollback firewall", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const checkpointId = await session.snapshot();

    runNodeMutation(
      root,
      "const fs = require('node:fs'); fs.writeFileSync('child-created.txt', 'child');",
    );
    await session.rollback(checkpointId);

    assert.equal(existsSync(path.join(root, "child-created.txt")), false);
  });

  it("records reconcile and rollback diagnostics", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const session = createSession(root);
    const checkpointId = await session.snapshot();
    fs.writeFileSync(path.join(root, "created.txt"), "created");

    const reconcileResult = await session.reconcile(checkpointId);
    await session.rollback(checkpointId);
    const diagnostics = session.diagnostics;
    const diagnosticsSnapshot = session.getDiagnostics();

    assert.equal(reconcileResult.created.includes("created.txt"), true);
    assert.equal(session.lastReconcileResult, reconcileResult);
    assert.equal(diagnostics.lastReconcileResult, reconcileResult);
    assert.equal(typeof diagnostics.lastRollbackMs, "number");
    assert.equal(diagnostics.strategy, session.strategy);
    assert.equal(diagnostics.isDisposed, false);
    assert.equal(diagnostics.activeCheckpointCount, 0);
    assert.deepEqual(diagnosticsSnapshot, diagnostics);
  });

  it("delegates recoverAttempts() to the workspace", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const checkpointId = await session.snapshot();
    const attempts = await session.recoverAttempts();

    assert.equal(attempts.some((attempt) => attempt.checkpointId === checkpointId), true);
  });

  it("delegates exportPatch() to the workspace", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const session = createSession(root);
    const checkpointId = await session.snapshot();
    fs.writeFileSync(path.join(root, "created.txt"), "created\n");

    const patch = await session.exportPatch(checkpointId);

    assert.match(patch, /diff --git a\/created\.txt b\/created\.txt/);
    assert.match(patch, /\+created/);
  });

  it("delegates promote() to the workspace", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const checkpointId = await session.snapshot();
    writeFileSync(path.join(root, "accepted.txt"), "accepted\n");

    const result = await session.promote(checkpointId, { exportPatch: true });

    assert.equal(result.checkpointId, checkpointId);
    assert.equal(result.storageCleaned, true);
    assert.match(result.patch ?? "", /accepted/);
    assert.equal(readFileSync(path.join(root, "accepted.txt"), "utf8"), "accepted\n");
    await assert.rejects(() => session.rollback(checkpointId), /promoted/);
  });

  it("delegates declareToolOutputs() to the workspace", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const checkpointId = await session.snapshot();

    assert.doesNotThrow(() => {
      session.declareToolOutputs({
        toolName: "formatter",
        checkpointId,
        outputs: ["dist/formatter-cache.json"],
      });
    });
  });

  it("delegates rehydrateAttempt() to the workspace", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const checkpointId = await session.snapshot();
    writeFileSync(path.join(root, "created.txt"), "created");
    await session.reconcile(checkpointId);
    session.workspace.uninstallFsInterceptor();

    const freshSession = createSession(root);
    const rehydratedId = await freshSession.rehydrateAttempt(checkpointId);

    assert.equal(rehydratedId, checkpointId);
    await freshSession.rollback(checkpointId);
    assert.equal(existsSync(path.join(root, "created.txt")), false);
  });

  it("runs a successful attempt with automatic snapshot and reconciliation", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const session = createSession(root);

    const attemptResult = await session.runAttempt(async ({ checkpointId }) => {
      assert.equal(typeof checkpointId, "string");
      fs.writeFileSync(path.join(root, "created.txt"), "created");
      return "passed";
    });

    assert.equal(attemptResult.result, "passed");
    assert.equal(attemptResult.rolledBack, false);
    assert.equal(attemptResult.reconcileResult?.created.includes("created.txt"), true);
    assert.equal(session.lastReconcileResult, attemptResult.reconcileResult);
    assert.equal(readFileSync(path.join(root, "created.txt"), "utf8"), "created");
  });

  it("runAttempt can fork from parent checkpoints and preserve lineage", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const parentId = await session.snapshot({
      branchId: "branch-a",
      subagentId: "planner",
    });

    const inheritedAttempt = await session.runAttempt(
      async () => "ok",
      { parentCheckpointId: parentId },
    );
    const inheritedSummary = session.getCheckpointLineage(inheritedAttempt.checkpointId).at(-1);

    assert.equal(inheritedSummary?.parentId, parentId);
    assert.equal(inheritedSummary?.branchId, "branch-a");
    assert.equal(inheritedSummary?.subagentId, "planner");

    const overriddenAttempt = await session.runAttempt(async () => "ok", {
      parentCheckpointId: parentId,
      branchId: "branch-b",
      subagentId: "reviewer",
    });
    const overriddenSummary = session.getCheckpointLineage(overriddenAttempt.checkpointId).at(-1);

    assert.equal(overriddenSummary?.parentId, parentId);
    assert.equal(overriddenSummary?.branchId, "branch-b");
    assert.equal(overriddenSummary?.subagentId, "reviewer");
  });

  it("fails fast when runAttempt is called reentrantly", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);

    await session.runAttempt(async ({ checkpointId }) => {
      await assert.rejects(
        () => session.runAttempt(async () => "nested"),
        (error) => {
          assert.equal(error instanceof HyperionAttemptInProgressError, true);
          assert.equal(
            (error as HyperionAttemptInProgressError).activeCheckpointId,
            checkpointId,
          );
          return true;
        },
      );
    });
  });

  it("rolls back VFS and child-process writes when an attempt throws", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const session = createSession(root);
    const attemptError = new Error("attempt failed");

    await assert.rejects(
      () =>
        session.runAttempt(async ({ exec }) => {
          fs.writeFileSync(sourcePath, "mutated");
          fs.writeFileSync(path.join(root, "created.txt"), "created");
          await exec(process.execPath, [
            "-e",
            "require('node:fs').writeFileSync('child-created.txt', 'child')",
          ], { captureOutput: true });
          throw attemptError;
        }),
      (error) => {
        assert.equal(error, attemptError);
        assert.equal((error as { rolledBack?: boolean }).rolledBack, true);
        assert.equal(typeof (error as { checkpointId?: string }).checkpointId, "string");
        assert.equal(typeof (error as { rollbackMs?: number }).rollbackMs, "number");
        return true;
      },
    );

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
    assert.equal(existsSync(path.join(root, "created.txt")), false);
    assert.equal(existsSync(path.join(root, "child-created.txt")), false);
  });

  it("can leave failed attempt files in place when rollbackOnThrow is false", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const session = createSession(root);
    const attemptError = new Error("inspect failure");

    await assert.rejects(
      () =>
        session.runAttempt(
          () => {
            fs.writeFileSync(path.join(root, "created.txt"), "created");
            throw attemptError;
          },
          { rollbackOnThrow: false },
        ),
      (error) => {
        assert.equal(error, attemptError);
        assert.equal((error as { rolledBack?: boolean }).rolledBack, false);
        assert.equal(typeof (error as { checkpointId?: string }).checkpointId, "string");
        return true;
      },
    );

    assert.equal(readFileSync(path.join(root, "created.txt"), "utf8"), "created");
  });

  it("can skip success reconciliation", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const session = createSession(root);

    const attemptResult = await session.runAttempt(
      () => {
        fs.writeFileSync(path.join(root, "created.txt"), "created");
        return "done";
      },
      { reconcileOnSuccess: false },
    );

    assert.equal(attemptResult.result, "done");
    assert.equal(attemptResult.reconcileResult, undefined);
    assert.equal(session.lastReconcileResult, undefined);
  });

  it("reconciles after context exec creates a file", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);

    await session.runAttempt(async ({ exec }) => {
      await exec(process.execPath, [
        "-e",
        "require('node:fs').writeFileSync('exec-created.txt', 'created')",
      ], { captureOutput: true });
      assert.equal(session.lastReconcileResult?.created.includes("exec-created.txt"), true);
    });
  });

  it("rejects non-zero context exec by default and triggers rollback", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const session = createSession(root);

    await assert.rejects(
      () =>
        session.runAttempt(async ({ exec }) => {
          fs.writeFileSync(path.join(root, "created.txt"), "created");
          await exec(process.execPath, ["-e", "process.exit(7)"], { captureOutput: true });
        }),
      (error) => {
        assert.equal(error instanceof HyperionExecError, true);
        assert.equal((error as HyperionExecError).code, "HYPERION_EXEC");
        assert.equal((error as HyperionExecError).result.exitCode, 7);
        assert.equal((error as { rolledBack?: boolean }).rolledBack, true);
        return true;
      },
    );

    assert.equal(existsSync(path.join(root, "created.txt")), false);
  });

  it("returns non-zero exec results when rejectOnNonZero is false", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);

    const result = await session.exec(
      process.execPath,
      ["-e", "process.exit(9)"],
      { captureOutput: true, rejectOnNonZero: false },
    );

    assert.equal(result.exitCode, 9);
    assert.equal(result.signal, null);
  });

  it("captures stdout and stderr from exec", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);

    const result = await session.exec(
      process.execPath,
      ["-e", "console.log('out'); console.error('err');"],
      { captureOutput: true },
    );

    assert.match(result.stdout ?? "", /out/);
    assert.match(result.stderr ?? "", /err/);
  });

  it("times out hung child processes in exec", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const startedAt = Date.now();

    await assert.rejects(
      () => session.exec(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { timeoutMs: 200 }),
      (error) => {
        assert.equal(error instanceof HyperionExecTimeoutError, true);
        assert.equal((error as HyperionExecTimeoutError).code, "HYPERION_EXEC_TIMEOUT");
        assert.equal((error as HyperionExecTimeoutError).timeoutMs, 200);
        assert.match((error as Error).message, /Command timed out after 200ms/);
        return true;
      },
    );

    assert.ok(Date.now() - startedAt < 5_000);
  });

  it("validates timeoutMs options with a typed error", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);

    await assert.rejects(
      () => session.exec(process.execPath, ["--version"], { timeoutMs: Number.NaN }),
      (error) => {
        assert.equal(error instanceof HyperionExecOptionsError, true);
        assert.equal((error as HyperionExecOptionsError).code, "HYPERION_EXEC_OPTIONS");
        assert.match((error as Error).message, /timeoutMs must be a non-negative finite number/);
        return true;
      },
    );
  });

  it("rolls back attempt changes when context exec times out", async () => {
    const root = createTempWorkspace();
    const fs = getCommonJsFs();
    const session = createSession(root);

    await assert.rejects(
      () =>
        session.runAttempt(async ({ exec }) => {
          fs.writeFileSync(path.join(root, "created-before-timeout.txt"), "created");
          await exec(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { timeoutMs: 200 });
        }),
      (error) => {
        assert.equal(error instanceof HyperionExecTimeoutError, true);
        assert.match(String((error as Error).message), /Command timed out/);
        assert.equal((error as { rolledBack?: boolean }).rolledBack, true);
        return true;
      },
    );

    assert.equal(existsSync(path.join(root, "created-before-timeout.txt")), false);
  });

  it("wraps primitive attempt failures in a typed context error", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);

    await assert.rejects(
      () =>
        session.runAttempt(() => {
          throw "primitive-failure";
        }),
      (error) => {
        assert.equal(error instanceof HyperionAttemptContextError, true);
        assert.equal((error as HyperionAttemptContextError).code, "HYPERION_ATTEMPT_CONTEXT");
        assert.equal((error as HyperionAttemptContextError).value, "primitive-failure");
        assert.equal((error as { rolledBack?: boolean }).rolledBack, true);
        assert.equal(typeof (error as { checkpointId?: string }).checkpointId, "string");
        return true;
      },
    );
  });

  it("disposes idempotently and uninstalls the workspace interceptor", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);

    await session.dispose();
    await session.dispose();

    assert.equal(session.isDisposed, true);
    assert.equal(session.workspace.isFsInterceptorInstalled, false);
    assert.equal(session.diagnostics.isDisposed, true);
  });

  it("preserves enableFsInterceptor opt-out", async () => {
    const root = createTempWorkspace();
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");
    const session = createSession(root, false);
    const checkpointId = await session.snapshot();

    assert.equal(session.workspace.isFsInterceptorInstalled, false);
    writeFileSync(sourcePath, "mutated");
    await assert.rejects(() => session.rollback(checkpointId), /Missing backup record/);
    assert.equal(typeof session.lastRollbackMs, "number");
  });

  it("exports adapter type contracts from the package root", () => {
    const checkpointId: CheckpointId = "checkpoint";
    const reconcileResult: ReconcileResult = {
      checkpointId,
      created: [],
      modified: [],
      deleted: [],
      renamed: [],
    };
    const diagnostics: HyperionAgentSessionDiagnostics = {
      strategy: "pure-manifest",
      activeCheckpointCount: 0,
      checkpoints: [],
      ignoredWrites: [],
      lastReconcileResult: reconcileResult,
      lastRollbackMs: 1,
      isDisposed: false,
    };
    const attemptOptions: HyperionAttemptOptions = {
      rollbackOnThrow: true,
      reconcileOnSuccess: true,
      parentCheckpointId: checkpointId,
      branchId: "branch-a",
      subagentId: "planner",
      agentId: "agent-planner",
    };
    const execOptions: HyperionExecOptions = {
      captureOutput: true,
      rejectOnNonZero: false,
      timeoutMs: 1_000,
    };
    const execResult: HyperionExecResult = {
      command: "node",
      args: ["--version"],
      exitCode: 0,
      signal: null,
      stdout: "v20",
    };
    const attemptResult: HyperionAttemptResult<string> = {
      checkpointId,
      result: "ok",
      reconcileResult,
      rolledBack: false,
    };
    const context: Pick<HyperionAttemptContext, "checkpointId"> = {
      checkpointId,
    };

    assert.equal(diagnostics.lastReconcileResult?.checkpointId, checkpointId);
    assert.equal(attemptOptions.rollbackOnThrow, true);
    assert.equal(attemptOptions.agentId, "agent-planner");
    assert.equal(execOptions.captureOutput, true);
    assert.equal(execResult.exitCode, 0);
    assert.equal(attemptResult.result, "ok");
    assert.equal(context.checkpointId, checkpointId);
  });
});
