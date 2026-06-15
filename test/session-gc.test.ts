import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  HyperionSessionManager,
  STALE_SESSION_TTL_MS,
  type SessionGcAdapter,
} from "../src/internal/session-gc.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-session-gc-"));
  tempRoots.push(root);
  return root;
}

function createAdapter(options: {
  livePids?: Set<number>;
  now?: number;
  chmodCalls?: string[];
} = {}): SessionGcAdapter {
  return {
    pid: 100,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
    statSync,
    chmodSync(targetPath, mode) {
      options.chmodCalls?.push(targetPath);
      chmodSync(targetPath, mode);
    },
    rmSync,
    hostname: () => "test-host",
    now: () => options.now ?? Date.now(),
    isProcessAlive: (pid) => options.livePids?.has(pid) ?? false,
  };
}

function createSessionDir(
  workspaceRoot: string,
  sessionName: string,
  lockfileContent?: unknown,
): string {
  const sessionDir = path.join(workspaceRoot, ".hyperion", sessionName);
  mkdirSync(sessionDir, { recursive: true });

  if (lockfileContent !== undefined) {
    const content =
      typeof lockfileContent === "string"
        ? lockfileContent
        : JSON.stringify(lockfileContent);
    writeFileSync(path.join(sessionDir, "lock.json"), content);
  }

  return sessionDir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("HyperionSessionManager", () => {
  it("creates a current session directory with lock metadata", () => {
    const workspaceRoot = createTempRoot();
    const manager = new HyperionSessionManager({
      workspaceRoot,
      sessionId: "session-a",
      adapter: createAdapter({ livePids: new Set([100]) }),
    });

    manager.initialize();

    const lockfile = JSON.parse(readFileSync(manager.lockfilePath, "utf8")) as {
      pid: number;
      hostname: string;
      createdAt: number;
      sessionId: string;
      sdkVersion: string;
    };
    assert.equal(existsSync(manager.sessionDir), true);
    assert.equal(lockfile.pid, 100);
    assert.equal(lockfile.hostname, "test-host");
    assert.equal(lockfile.sessionId, "session-a");
    assert.equal(typeof lockfile.createdAt, "number");
    assert.equal(typeof lockfile.sdkVersion, "string");
  });

  it("removes stale sessions whose owner process is gone", () => {
    const workspaceRoot = createTempRoot();
    const staleSession = createSessionDir(workspaceRoot, "session-stale", {
      pid: 200,
      hostname: "test-host",
      createdAt: Date.now(),
      sessionId: "stale",
    });
    const liveSession = createSessionDir(workspaceRoot, "session-live", {
      pid: 300,
      hostname: "test-host",
      createdAt: Date.now(),
      sessionId: "live",
    });

    const manager = new HyperionSessionManager({
      workspaceRoot,
      sessionId: "current",
      adapter: createAdapter({ livePids: new Set([300]) }),
    });
    manager.initialize();

    assert.equal(existsSync(staleSession), false);
    assert.equal(existsSync(liveSession), true);
  });

  it("removes old corrupt or missing-lock session directories", () => {
    const workspaceRoot = createTempRoot();
    const corruptSession = createSessionDir(workspaceRoot, "session-corrupt", "{");
    const missingLockSession = createSessionDir(workspaceRoot, "session-missing");
    const oldEnoughNow = Date.now() + STALE_SESSION_TTL_MS + 1000;

    const manager = new HyperionSessionManager({
      workspaceRoot,
      sessionId: "current",
      adapter: createAdapter({ now: oldEnoughNow }),
    });
    manager.initialize();

    assert.equal(existsSync(corruptSession), false);
    assert.equal(existsSync(missingLockSession), false);
  });

  it("does not remove non-session Hyperion paths or files outside .hyperion", () => {
    const workspaceRoot = createTempRoot();
    const nonSessionPath = path.join(workspaceRoot, ".hyperion", "not-session", "safe.txt");
    const outsidePath = path.join(workspaceRoot, "safe.txt");
    mkdirSync(path.dirname(nonSessionPath), { recursive: true });
    writeFileSync(nonSessionPath, "safe");
    writeFileSync(outsidePath, "safe");

    const manager = new HyperionSessionManager({
      workspaceRoot,
      sessionId: "current",
      adapter: createAdapter(),
    });
    manager.initialize();

    assert.equal(readFileSync(nonSessionPath, "utf8"), "safe");
    assert.equal(readFileSync(outsidePath, "utf8"), "safe");
  });

  it("attempts permission restoration before deleting stale sessions", () => {
    const workspaceRoot = createTempRoot();
    const chmodCalls: string[] = [];
    const staleSession = createSessionDir(workspaceRoot, "session-stale", {
      pid: 200,
      hostname: "test-host",
      createdAt: Date.now(),
      sessionId: "stale",
    });

    const manager = new HyperionSessionManager({
      workspaceRoot,
      sessionId: "current",
      adapter: createAdapter({ chmodCalls }),
    });
    manager.initialize();

    assert.equal(existsSync(staleSession), false);
    assert.equal(chmodCalls.includes(staleSession), true);
  });

  it("cleans only Hyperion rollback temp files and respects skipped subtrees", () => {
    const workspaceRoot = createTempRoot();
    const sourceDir = path.join(workspaceRoot, "src");
    const ignoredDir = path.join(workspaceRoot, "node_modules");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(ignoredDir, { recursive: true });
    writeFileSync(path.join(sourceDir, ".hyperion-source-1.tmp"), "temp");
    writeFileSync(path.join(sourceDir, ".hyperion-link-source-1.tmp"), "temp");
    writeFileSync(path.join(sourceDir, "ordinary.tmp"), "safe");
    writeFileSync(path.join(ignoredDir, ".hyperion-ignored-1.tmp"), "safe");

    const manager = new HyperionSessionManager({
      workspaceRoot,
      sessionId: "current",
      adapter: createAdapter(),
      shouldSkipWorkspacePath: (relativePath) => relativePath === "node_modules",
    });
    manager.initialize();

    assert.equal(existsSync(path.join(sourceDir, ".hyperion-source-1.tmp")), false);
    assert.equal(existsSync(path.join(sourceDir, ".hyperion-link-source-1.tmp")), false);
    assert.equal(readFileSync(path.join(sourceDir, "ordinary.tmp"), "utf8"), "safe");
    assert.equal(readFileSync(path.join(ignoredDir, ".hyperion-ignored-1.tmp"), "utf8"), "safe");
  });

  it("removes the current session directory idempotently", () => {
    const workspaceRoot = createTempRoot();
    const manager = new HyperionSessionManager({
      workspaceRoot,
      sessionId: "current",
      adapter: createAdapter({ livePids: new Set([100]) }),
    });
    manager.initialize();

    manager.cleanupCurrentSession();
    manager.cleanupCurrentSession();

    assert.equal(existsSync(manager.sessionDir), false);
  });
});
