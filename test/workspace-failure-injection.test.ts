import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  HyperionIntegrityError,
  HyperionRollbackError,
  HyperionWorkspace,
  type CheckpointId,
  type HyperionConfig,
  type StateManifest,
} from "../src/index.js";
import type { StorageStrategy } from "../src/internal/storage-strategy.js";

const require = createRequire(import.meta.url);
const tempRoots: string[] = [];
const activeWorkspaces: HyperionWorkspace[] = [];

// Writes through the CommonJS fs object are seen by the interceptor and backed up.
function getCommonJsFs(): typeof import("node:fs") {
  return require("node:fs") as typeof import("node:fs");
}

// Child-process writes bypass the interceptor, so modified files get no backup.
function runChildMutation(root: string, script: string): void {
  execFileSync(process.execPath, ["-e", script], { cwd: root, stdio: "ignore" });
}

function getCheckpointStatus(workspace: HyperionWorkspace, checkpointId: string): string | undefined {
  return workspace
    .getDiagnostics()
    .checkpoints.find((checkpoint) => checkpoint.checkpointId === checkpointId)?.status;
}

function getCheckpointStorage(workspace: HyperionWorkspace, checkpointId: CheckpointId): StorageStrategy {
  const storage = (
    workspace as unknown as { checkpointStorage: Map<CheckpointId, StorageStrategy> }
  ).checkpointStorage.get(checkpointId);
  assert.ok(storage, "checkpoint storage exists");
  return storage;
}

// Returns the on-disk backup file for a path, failing if the backup is held only in memory.
function getDiskBackupPath(
  workspace: HyperionWorkspace,
  checkpointId: CheckpointId,
  relativePath: string,
): string {
  const record = getCheckpointStorage(workspace, checkpointId).getBackupRecord(relativePath);
  assert.equal(record?.kind, "file");
  assert.ok(record?.backupPath, `disk backup expected for ${relativePath}`);
  assert.equal(existsSync(record.backupPath), true);
  return record.backupPath;
}

// Captures every workspace file and directory outside .hyperion so a test can assert no change.
function readWorkspaceTree(root: string, relativeDir = ""): Record<string, string> {
  const tree: Record<string, string> = {};

  for (const entry of readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

    if (relativePath === ".hyperion") {
      continue;
    }

    if (entry.isDirectory()) {
      tree[`${relativePath}/`] = "<dir>";
      Object.assign(tree, readWorkspaceTree(root, relativePath));
    } else {
      tree[relativePath] = readFileSync(path.join(root, relativePath), "utf8");
    }
  }

  return tree;
}

function createTempWorkspaceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-failure-injection-"));
  tempRoots.push(root);
  return root;
}

function createWorkspace(
  root: string,
  enableFsInterceptor = true,
  config: Omit<HyperionConfig, "workspaceRoot" | "enableFsInterceptor"> = {},
): HyperionWorkspace {
  const workspace = new HyperionWorkspace({ ...config, workspaceRoot: root, enableFsInterceptor });

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

  it("does not delete created files when a modified file has no backup record", async () => {
    const root = createTempWorkspaceRoot();
    const fs = getCommonJsFs();
    const sourcePath = path.join(root, "source.txt");
    const createdPath = path.join(root, "created.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(createdPath, "created by agent");
    runChildMutation(root, "require('node:fs').writeFileSync('source.txt', 'child mutated')");

    await assert.rejects(
      () => workspace.rollback(checkpointId),
      (error) => {
        assert.equal(error instanceof HyperionIntegrityError, true);
        assert.match((error as Error).message, /Missing backup record for source\.txt/);
        return true;
      },
    );

    assert.equal(readFileSync(createdPath, "utf8"), "created by agent");
    assert.equal(readFileSync(sourcePath, "utf8"), "child mutated");
    assert.equal(getCheckpointStatus(workspace, checkpointId), "active");
  });

  it("leaves every path untouched when the unbacked entry is late in restoration order", async () => {
    const root = createTempWorkspaceRoot();
    const fs = getCommonJsFs();
    mkdirSync(path.join(root, "src"));
    for (const name of ["src/alpha.ts", "src/beta.ts", "removed-by-agent.txt", "removed-by-child.txt"]) {
      writeFileSync(path.join(root, name), `original ${name}`);
    }
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(path.join(root, "src/alpha.ts"), "agent alpha");
    fs.writeFileSync(path.join(root, "src/beta.ts"), "agent beta");
    fs.mkdirSync(path.join(root, "generated/deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "generated/deep/out.js"), "generated");
    fs.writeFileSync(path.join(root, "notes.md"), "created");
    fs.rmSync(path.join(root, "removed-by-agent.txt"));
    // Deleted entries are restored after modified ones, so this is the last operation.
    runChildMutation(root, "require('node:fs').rmSync('removed-by-child.txt')");

    await assert.rejects(
      () => workspace.rollback(checkpointId),
      /Missing backup record for removed-by-child\.txt/,
    );

    assert.equal(readFileSync(path.join(root, "src/alpha.ts"), "utf8"), "agent alpha");
    assert.equal(readFileSync(path.join(root, "src/beta.ts"), "utf8"), "agent beta");
    assert.equal(readFileSync(path.join(root, "generated/deep/out.js"), "utf8"), "generated");
    assert.equal(readFileSync(path.join(root, "notes.md"), "utf8"), "created");
    assert.equal(existsSync(path.join(root, "removed-by-agent.txt")), false);
    assert.equal(existsSync(path.join(root, "removed-by-child.txt")), false);
    assert.equal(getCheckpointStatus(workspace, checkpointId), "active");
  });

  it("fails the same way on retry without mutating the workspace", async () => {
    const root = createTempWorkspaceRoot();
    const fs = getCommonJsFs();
    const sourcePath = path.join(root, "source.txt");
    const createdPath = path.join(root, "created.txt");
    writeFileSync(sourcePath, "original");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(createdPath, "created by agent");
    runChildMutation(root, "require('node:fs').writeFileSync('source.txt', 'child mutated')");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await assert.rejects(() => workspace.rollback(checkpointId), HyperionIntegrityError);
      assert.equal(existsSync(createdPath), true, `created file kept after attempt ${attempt}`);
      assert.equal(readFileSync(sourcePath, "utf8"), "child mutated");
      assert.equal(getCheckpointStatus(workspace, checkpointId), "active");
    }

    await workspace.dispose();
    assert.equal(existsSync(createdPath), true);
  });

  it("restores created, modified, and deleted files when every backup exists", async () => {
    const root = createTempWorkspaceRoot();
    const fs = getCommonJsFs();
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/keep.ts"), "original keep");
    writeFileSync(path.join(root, "delete-me.txt"), "original delete");
    const workspace = createWorkspace(root);
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(path.join(root, "src/keep.ts"), "agent edit");
    fs.rmSync(path.join(root, "delete-me.txt"));
    fs.mkdirSync(path.join(root, "generated/deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "generated/deep/out.js"), "generated");
    fs.writeFileSync(path.join(root, "src/new.ts"), "created");

    await workspace.rollback(checkpointId);

    assert.equal(readFileSync(path.join(root, "src/keep.ts"), "utf8"), "original keep");
    assert.equal(readFileSync(path.join(root, "delete-me.txt"), "utf8"), "original delete");
    assert.equal(existsSync(path.join(root, "src/new.ts")), false);
    assert.equal(existsSync(path.join(root, "generated")), false);
    assert.equal(getCheckpointStatus(workspace, checkpointId), "disposed");
  });

  for (const [label, config] of [
    ["disk backups", { useHotBuffer: false }],
    ["hot buffer spilled to disk", { hotBufferMaxFileBytes: 1 }],
  ] as const) {
    it(`detects a deleted backup file before mutating the workspace (${label})`, async () => {
      const root = createTempWorkspaceRoot();
      const fs = getCommonJsFs();
      writeFileSync(path.join(root, "source.txt"), "original");
      const workspace = createWorkspace(root, true, config);
      const checkpointId = await workspace.snapshot();

      fs.writeFileSync(path.join(root, "created.txt"), "created by agent");
      fs.writeFileSync(path.join(root, "source.txt"), "agent edit");
      rmSync(getDiskBackupPath(workspace, checkpointId, "source.txt"));
      const before = readWorkspaceTree(root);

      await assert.rejects(
        () => workspace.rollback(checkpointId),
        (error) => {
          assert.equal(error instanceof HyperionIntegrityError, true);
          assert.match((error as Error).message, /Missing backup for source\.txt/);
          return true;
        },
      );

      assert.deepEqual(readWorkspaceTree(root), before);
      assert.equal(getCheckpointStatus(workspace, checkpointId), "active");
    });
  }

  it("detects a backup path that is not a regular file before mutating the workspace", async () => {
    const root = createTempWorkspaceRoot();
    const fs = getCommonJsFs();
    writeFileSync(path.join(root, "source.txt"), "original");
    const workspace = createWorkspace(root, true, { useHotBuffer: false });
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(path.join(root, "created.txt"), "created by agent");
    fs.writeFileSync(path.join(root, "source.txt"), "agent edit");
    const backupPath = getDiskBackupPath(workspace, checkpointId, "source.txt");
    rmSync(backupPath);
    mkdirSync(backupPath);
    const before = readWorkspaceTree(root);

    await assert.rejects(
      () => workspace.rollback(checkpointId),
      (error) => {
        assert.equal(error instanceof HyperionIntegrityError, true);
        assert.match((error as Error).message, /Backup for source\.txt is not a regular file/);
        return true;
      },
    );

    assert.deepEqual(readWorkspaceTree(root), before);
    assert.equal(getCheckpointStatus(workspace, checkpointId), "active");
  });

  for (const [label, linkTarget] of [
    ["no link target", undefined],
    ["an empty link target", ""],
  ] as const) {
    it(`detects a symlink backup record with ${label} before mutating the workspace`, async () => {
      const root = createTempWorkspaceRoot();
      const fs = getCommonJsFs();
      writeFileSync(path.join(root, "source.txt"), "original");
      const workspace = createWorkspace(root, true, { useHotBuffer: false });
      const checkpointId = await workspace.snapshot();

      fs.writeFileSync(path.join(root, "created.txt"), "created by agent");
      fs.writeFileSync(path.join(root, "source.txt"), "agent edit");
      // Simulate a corrupt hydrated record: the path is recorded as a symlink without a target.
      const storage = getCheckpointStorage(workspace, checkpointId);
      storage.hydrateBackupRecords?.(
        storage.getBackupRecords().map((record) =>
          record.relativePath === "source.txt"
            ? {
                relativePath: record.relativePath,
                kind: "symlink" as const,
                ...(linkTarget === undefined ? {} : { linkTarget }),
              }
            : record,
        ),
      );
      const before = readWorkspaceTree(root);

      await assert.rejects(
        () => workspace.rollback(checkpointId),
        (error) => {
          assert.equal(error instanceof HyperionIntegrityError, true);
          assert.match((error as Error).message, /Missing symlink target for source\.txt/);
          return true;
        },
      );

      assert.deepEqual(readWorkspaceTree(root), before);
      assert.equal(getCheckpointStatus(workspace, checkpointId), "active");
    });
  }

  it("leaves every path unchanged when the unusable backup is last in restoration order", async () => {
    const root = createTempWorkspaceRoot();
    const fs = getCommonJsFs();
    mkdirSync(path.join(root, "src"));
    for (const name of ["src/alpha.ts", "src/beta.ts", "README.md", "zz-removed.txt"]) {
      writeFileSync(path.join(root, name), `original ${name}`);
    }
    const workspace = createWorkspace(root, true, { useHotBuffer: false });
    const checkpointId = await workspace.snapshot();

    fs.writeFileSync(path.join(root, "src/alpha.ts"), "agent alpha");
    fs.writeFileSync(path.join(root, "src/beta.ts"), "agent beta");
    fs.writeFileSync(path.join(root, "README.md"), "agent readme");
    fs.mkdirSync(path.join(root, "generated/deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "generated/deep/out.js"), "generated");
    fs.writeFileSync(path.join(root, "src/new.ts"), "created");
    fs.writeFileSync(path.join(root, "notes.md"), "created");
    // Deleted entries are restored after modified ones, so this backup is used last.
    fs.rmSync(path.join(root, "zz-removed.txt"));
    rmSync(getDiskBackupPath(workspace, checkpointId, "zz-removed.txt"));
    const before = readWorkspaceTree(root);

    await assert.rejects(
      () => workspace.rollback(checkpointId),
      /Missing backup for zz-removed\.txt/,
    );

    assert.deepEqual(readWorkspaceTree(root), before);
    assert.equal(getCheckpointStatus(workspace, checkpointId), "active");
  });
});
