import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HyperionIntegrityError } from "../src/index.js";
import type { StoredCheckpoint } from "../src/internal/checkpoint-store.js";
import { RollbackEngine } from "../src/internal/rollback-engine.js";
import type { StorageBackupRecord, StorageStrategy } from "../src/internal/storage-strategy.js";
import type { DirtyEntry, HyperionStorageDiagnostics, StateManifest } from "../src/types.js";

function createManifest(): StateManifest {
  return {
    gitAvailable: false,
    gitIndexEntries: new Map(),
    statEntries: new Map(),
    ignoredPatterns: [],
    capturedAt: 1,
  };
}

function createDirtyEntry(relativePath: string, kind: DirtyEntry["kind"]): DirtyEntry {
  return {
    relativePath,
    kind,
    fileType: "file",
    capturedBy: "track",
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

function createCheckpoint(entries: ReadonlyArray<DirtyEntry>): StoredCheckpoint {
  return {
    id: "checkpoint-1",
    baseline: createManifest(),
    dirty: new Map(entries.map((entry) => [entry.relativePath, entry])),
    storageNamespace: ".hyperion/checkpoints/checkpoint-1",
    status: "active",
    createdAt: 1,
    lock: { locked: false },
  };
}

function createStorage(records: ReadonlyArray<StorageBackupRecord>): StorageStrategy {
  const recordsByPath = new Map(records.map((record) => [record.relativePath, record]));

  return {
    backupFile(relativePath) {
      return recordsByPath.get(relativePath) ?? { relativePath, kind: "missing" };
    },
    restoreFile(relativePath) {
      if (!recordsByPath.has(relativePath)) {
        throw new Error(`Unexpected restore request: ${relativePath}`);
      }

      return { relativePath, restored: true, deleted: false };
    },
    deleteCreatedPath() {},
    getBackupRecord(relativePath) {
      return recordsByPath.get(relativePath);
    },
    getBackupRecords() {
      return [...recordsByPath.values()];
    },
    readBackupFile() {
      return undefined;
    },
    getDiagnostics(): HyperionStorageDiagnostics {
      return {
        physicalStrategy: "pure-manifest",
        backupRecordCount: recordsByPath.size,
        hotBuffer: {
          enabled: false,
          memoryHits: 0,
          spills: 0,
          bytesUsed: 0,
          filesUsed: 0,
        },
      };
    },
  };
}

describe("RollbackEngine failure injection", () => {
  it("restores checkpoint lock and status when reconcile fails", async () => {
    const checkpoint = createCheckpoint([createDirtyEntry("created.txt", "created")]);
    const storage = createStorage([]);
    const rollbackEngine = new RollbackEngine();
    const reconcileError = new Error("reconcile denied");

    await assert.rejects(
      () =>
        rollbackEngine.rollback({
          checkpoint,
          storage,
          ghostDirectoryCleaner: {
            cleanupAfterCreatedPath() {},
          } as unknown as import("../src/internal/ghost-directory-cleaner.js").GhostDirectoryCleaner,
          reconcile: async () => {
            throw reconcileError;
          },
        }),
      (error) => {
        assert.equal(error, reconcileError);
        return true;
      },
    );

    assert.equal(checkpoint.status, "active");
    assert.equal(checkpoint.lock.locked, false);
    assert.equal(checkpoint.dirty.has("created.txt"), true);
  });

  it("preserves unprocessed dirty entries after a partial restore failure", async () => {
    const checkpoint = createCheckpoint([
      createDirtyEntry("created.txt", "created"),
      createDirtyEntry("changed.txt", "modified"),
      createDirtyEntry("later.txt", "modified"),
    ]);
    const storage = createStorage([
      { relativePath: "changed.txt", kind: "file", backupPath: "/tmp/changed.txt" },
      { relativePath: "later.txt", kind: "file", backupPath: "/tmp/later.txt" },
    ]);
    const rollbackEngine = new RollbackEngine();

    storage.restoreFile = () => {
      throw new Error("restore write blocked");
    };

    await assert.rejects(() =>
      rollbackEngine.rollback({
        checkpoint,
        storage,
        ghostDirectoryCleaner: {
          cleanupAfterCreatedPath() {},
        } as unknown as import("../src/internal/ghost-directory-cleaner.js").GhostDirectoryCleaner,
        reconcile: async () => {},
      }),
    );

    assert.equal(checkpoint.status, "active");
    assert.equal(checkpoint.lock.locked, false);
    assert.equal(checkpoint.dirty.has("created.txt"), false);
    assert.equal(checkpoint.dirty.has("changed.txt"), true);
    assert.equal(checkpoint.dirty.has("later.txt"), true);
  });

  it("fails loudly on missing backup records and keeps checkpoint retry-safe", async () => {
    const checkpoint = createCheckpoint([createDirtyEntry("changed.txt", "modified")]);
    const storage = createStorage([]);
    const rollbackEngine = new RollbackEngine();

    await assert.rejects(
      () =>
        rollbackEngine.rollback({
          checkpoint,
          storage,
          ghostDirectoryCleaner: {
            cleanupAfterCreatedPath() {},
          } as unknown as import("../src/internal/ghost-directory-cleaner.js").GhostDirectoryCleaner,
          reconcile: async () => {},
        }),
      (error) => {
        assert.equal(error instanceof HyperionIntegrityError, true);
        assert.match((error as Error).message, /Missing backup record for changed\.txt/);
        return true;
      },
    );

    assert.equal(checkpoint.status, "active");
    assert.equal(checkpoint.lock.locked, false);
    assert.equal(checkpoint.dirty.has("changed.txt"), true);
  });
});
