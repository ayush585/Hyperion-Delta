import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { DEFAULT_IGNORED_PATTERNS, HyperionPathError, HyperionRollbackError, HyperionWorkspace } from "../src/index.js";

const tempRoots: string[] = [];

function createTempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "hyperion-workspace-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("HyperionWorkspace", () => {
  it("can instantiate with a workspace root string", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.equal(workspace.root, resolve(root));
    assert.equal(workspace.config.workspaceRoot, resolve(root));
    assert.equal(workspace.strategy, "pure-manifest");
  });

  it("can instantiate with a config object", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({ workspaceRoot: root, useTmpfs: false });

    assert.equal(workspace.root, resolve(root));
    assert.equal(workspace.config.useTmpfs, false);
  });

  it("rejects a missing workspace root", () => {
    const root = join(tmpdir(), `hyperion-missing-${Date.now()}`);

    assert.throws(() => new HyperionWorkspace(root), HyperionPathError);
  });

  it("rejects a file path as workspace root", () => {
    const root = createTempWorkspace();
    const filePath = join(root, "file.txt");
    writeFileSync(filePath, "not a directory");

    assert.throws(() => new HyperionWorkspace(filePath), HyperionPathError);
  });

  it("resolves default ignored patterns", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.deepEqual(workspace.config.ignoredPatterns, [...DEFAULT_IGNORED_PATTERNS]);
    assert.ok(workspace.config.ignoredPatterns.includes("node_modules/**"));
    assert.ok(workspace.config.ignoredPatterns.includes(".git/**"));
    assert.ok(workspace.config.ignoredPatterns.includes(".hyperion/**"));
  });

  it("extends default ignored patterns by default", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      ignoredPatterns: ["custom-output/**"],
    });

    assert.ok(workspace.config.ignoredPatterns.includes("node_modules/**"));
    assert.ok(workspace.config.ignoredPatterns.includes("custom-output/**"));
  });

  it("can replace default ignored patterns with overrideDefaultIgnores", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace({
      workspaceRoot: root,
      ignoredPatterns: ["only-this/**"],
      overrideDefaultIgnores: true,
    });

    assert.deepEqual(workspace.config.ignoredPatterns, ["only-this/**"]);
  });

  it("exposes public methods with expected runtime types", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.equal(typeof workspace.track, "function");
    assert.equal(typeof workspace.snapshot, "function");
    assert.equal(typeof workspace.rollback, "function");
    assert.equal(typeof workspace.reconcile, "function");
    assert.equal(typeof workspace.dispose, "function");
    assert.equal(typeof workspace.installFsInterceptor, "function");
    assert.equal(typeof workspace.uninstallFsInterceptor, "function");
  });

  it("validates track input shape", () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.doesNotThrow(() => workspace.track("src/index.ts"));
    assert.doesNotThrow(() => workspace.track(["src/index.ts", "src/workspace.ts"]));
    assert.throws(() => workspace.track([]), HyperionPathError);
    assert.throws(() => workspace.track([""]), HyperionPathError);
  });

  it("throws typed stubs for unimplemented snapshot and rollback", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    await assert.rejects(() => workspace.snapshot(), /snapshot\(\) is not implemented yet/);
    await assert.rejects(() => workspace.rollback("checkpoint"), HyperionRollbackError);
  });

  it("returns an empty reconcile result without a checkpoint during Phase 1A", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    assert.deepEqual(await workspace.reconcile(), {
      created: [],
      modified: [],
      deleted: [],
      renamed: [],
    });
  });

  it("has idempotent no-op interceptor and dispose methods", async () => {
    const root = createTempWorkspace();
    const workspace = new HyperionWorkspace(root);

    workspace.installFsInterceptor();
    workspace.installFsInterceptor();
    assert.equal(workspace.isFsInterceptorInstalled, true);

    workspace.uninstallFsInterceptor();
    workspace.uninstallFsInterceptor();
    assert.equal(workspace.isFsInterceptorInstalled, false);

    await workspace.dispose();
    await workspace.dispose();
    assert.equal(workspace.isDisposed, true);
  });
});
