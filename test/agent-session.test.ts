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
  HyperionExecError,
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
    assert.ok(["tmpfs", "posix-link", "pure-manifest"].includes(session.strategy));
  });

  it("returns checkpoint IDs through the wrapper snapshot method", async () => {
    const root = createTempWorkspace();
    const session = createSession(root);
    const checkpointId = await session.snapshot();

    assert.equal(typeof checkpointId, "string");
    assert.notEqual(checkpointId.length, 0);
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

    assert.equal(reconcileResult.created.includes("created.txt"), true);
    assert.equal(session.lastReconcileResult, reconcileResult);
    assert.equal(diagnostics.lastReconcileResult, reconcileResult);
    assert.equal(typeof diagnostics.lastRollbackMs, "number");
    assert.equal(diagnostics.strategy, session.strategy);
    assert.equal(diagnostics.isDisposed, false);
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
      lastReconcileResult: reconcileResult,
      lastRollbackMs: 1,
      isDisposed: false,
    };
    const attemptOptions: HyperionAttemptOptions = {
      rollbackOnThrow: true,
      reconcileOnSuccess: true,
    };
    const execOptions: HyperionExecOptions = {
      captureOutput: true,
      rejectOnNonZero: false,
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
    assert.equal(execOptions.captureOutput, true);
    assert.equal(execResult.exitCode, 0);
    assert.equal(attemptResult.result, "ok");
    assert.equal(context.checkpointId, checkpointId);
  });
});
