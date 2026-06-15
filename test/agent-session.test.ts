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
  type HyperionAgentSessionDiagnostics,
  type CheckpointId,
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

    assert.equal(diagnostics.lastReconcileResult?.checkpointId, checkpointId);
  });
});
