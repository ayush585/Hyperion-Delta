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

function createDirectoryEntry(relativePath: string, kind: DirtyEntry["kind"]): DirtyEntry {
  return { ...createDirtyEntry(relativePath, kind), fileType: "directory" };
}

function fileRecord(relativePath: string): StorageBackupRecord {
  return { relativePath, kind: "file", backupPath: `/tmp/${relativePath}` };
}

function createRecordingStorage(records: ReadonlyArray<StorageBackupRecord>): {
  storage: StorageStrategy;
  calls: string[];
  addRecord(record: StorageBackupRecord): void;
} {
  const recordsByPath = new Map(records.map((record) => [record.relativePath, record]));
  const calls: string[] = [];
  const storage = createStorage([]);

  storage.getBackupRecord = (relativePath) => recordsByPath.get(relativePath);
  storage.restoreFile = (relativePath) => {
    if (!recordsByPath.has(relativePath)) {
      throw new Error(`Unexpected restore request: ${relativePath}`);
    }

    calls.push(`restore:${relativePath}`);
    return { relativePath, restored: true, deleted: false };
  };
  storage.deleteCreatedPath = (relativePath) => {
    calls.push(`delete:${relativePath}`);
  };

  return {
    storage,
    calls,
    addRecord(record) {
      recordsByPath.set(record.relativePath, record);
    },
  };
}

function createRecordingGhostCleaner(calls: string[]) {
  return {
    cleanupAfterCreatedPath(relativePath: string) {
      calls.push(`ghost:${relativePath}`);
    },
  } as unknown as import("../src/internal/ghost-directory-cleaner.js").GhostDirectoryCleaner;
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

  it("detects a missing backup record before deleting created paths", async () => {
    const entries = [
      createDirtyEntry("created.txt", "created"),
      createDirtyEntry("nested/created-too.txt", "created"),
      createDirtyEntry("backed-up.txt", "modified"),
      createDirtyEntry("unbacked.txt", "modified"),
    ];
    const checkpoint = createCheckpoint(entries);
    const { storage, calls } = createRecordingStorage([fileRecord("backed-up.txt")]);

    await assert.rejects(
      () =>
        new RollbackEngine().rollback({
          checkpoint,
          storage,
          ghostDirectoryCleaner: createRecordingGhostCleaner(calls),
          reconcile: async () => {},
        }),
      (error) => {
        assert.equal(error instanceof HyperionIntegrityError, true);
        assert.match((error as Error).message, /Missing backup record for unbacked\.txt/);
        return true;
      },
    );

    assert.deepEqual(calls, []);
    assert.equal(checkpoint.status, "active");
    assert.equal(checkpoint.lock.locked, false);
    assert.deepEqual([...checkpoint.dirty.keys()].sort(), entries.map((entry) => entry.relativePath).sort());
  });

  it("detects a missing backup record that is last in restoration order", async () => {
    // Restoration order is modified, then deleted, then metadata; the unbacked
    // metadata entry would be the final operation without preflight.
    const checkpoint = createCheckpoint([
      createDirtyEntry("created-a.txt", "created"),
      createDirtyEntry("created-b.txt", "created"),
      createDirtyEntry("modified-a.txt", "modified"),
      createDirtyEntry("modified-b.txt", "modified"),
      createDirtyEntry("deleted-a.txt", "deleted"),
      createDirtyEntry("z.txt", "metadata"),
    ]);
    const { storage, calls } = createRecordingStorage([
      fileRecord("modified-a.txt"),
      fileRecord("modified-b.txt"),
      fileRecord("deleted-a.txt"),
    ]);

    await assert.rejects(
      () =>
        new RollbackEngine().rollback({
          checkpoint,
          storage,
          ghostDirectoryCleaner: createRecordingGhostCleaner(calls),
          reconcile: async () => {},
        }),
      /Missing backup record for z\.txt/,
    );

    assert.deepEqual(calls, []);
    assert.equal(checkpoint.dirty.size, 6);
    assert.equal(checkpoint.status, "active");
  });

  it("requires backup records for deleted entries, including deleted directories", async () => {
    for (const unbacked of [
      createDirtyEntry("deleted.txt", "deleted"),
      createDirectoryEntry("deleted-dir", "deleted"),
    ]) {
      const checkpoint = createCheckpoint([createDirtyEntry("created.txt", "created"), unbacked]);
      const { storage, calls } = createRecordingStorage([]);

      await assert.rejects(
        () =>
          new RollbackEngine().rollback({
            checkpoint,
            storage,
            ghostDirectoryCleaner: createRecordingGhostCleaner(calls),
            reconcile: async () => {},
          }),
        HyperionIntegrityError,
      );

      assert.deepEqual(calls, [], `no mutation expected for ${unbacked.relativePath}`);
      assert.equal(checkpoint.dirty.has("created.txt"), true);
    }
  });

  it("still skips modified directory entries that have no backup record", async () => {
    const checkpoint = createCheckpoint([
      createDirtyEntry("dir/created.txt", "created"),
      createDirectoryEntry("dir", "modified"),
      createDirtyEntry("changed.txt", "modified"),
    ]);
    const { storage, calls } = createRecordingStorage([fileRecord("changed.txt")]);

    await new RollbackEngine().rollback({
      checkpoint,
      storage,
      ghostDirectoryCleaner: createRecordingGhostCleaner(calls),
      reconcile: async () => {},
    });

    assert.deepEqual(calls, ["delete:dir/created.txt", "ghost:dir/created.txt", "restore:changed.txt"]);
    assert.equal(checkpoint.status, "disposed");
    assert.deepEqual([...checkpoint.dirty.keys()], ["dir"]);
  });

  it("completes a retry once the missing backup record is available", async () => {
    const checkpoint = createCheckpoint([
      createDirtyEntry("created.txt", "created"),
      createDirtyEntry("changed.txt", "modified"),
      createDirtyEntry("removed.txt", "deleted"),
    ]);
    const { storage, calls, addRecord } = createRecordingStorage([fileRecord("changed.txt")]);
    const options = {
      checkpoint,
      storage,
      ghostDirectoryCleaner: createRecordingGhostCleaner(calls),
      reconcile: async () => {},
    };

    await assert.rejects(() => new RollbackEngine().rollback(options), /removed\.txt/);
    assert.deepEqual(calls, []);

    addRecord(fileRecord("removed.txt"));
    await new RollbackEngine().rollback(options);

    assert.deepEqual(calls, [
      "delete:created.txt",
      "ghost:created.txt",
      "restore:changed.txt",
      "restore:removed.txt",
    ]);
    assert.equal(checkpoint.status, "disposed");
    assert.equal(checkpoint.dirty.size, 0);
  });

  it("retries only unprocessed entries after a mid-restore I/O failure", async () => {
    const checkpoint = createCheckpoint([
      createDirtyEntry("created.txt", "created"),
      createDirtyEntry("first-long-name.txt", "modified"),
      createDirtyEntry("second.txt", "modified"),
    ]);
    const { storage, calls } = createRecordingStorage([
      fileRecord("first-long-name.txt"),
      fileRecord("second.txt"),
    ]);
    const restore = storage.restoreFile.bind(storage);
    let failSecond = true;
    storage.restoreFile = (relativePath) => {
      if (relativePath === "second.txt" && failSecond) {
        failSecond = false;
        throw new Error("EBUSY: injected");
      }

      return restore(relativePath);
    };
    const options = {
      checkpoint,
      storage,
      ghostDirectoryCleaner: createRecordingGhostCleaner(calls),
      reconcile: async () => {},
    };

    await assert.rejects(() => new RollbackEngine().rollback(options), /EBUSY/);
    assert.equal(checkpoint.status, "active");
    assert.deepEqual([...checkpoint.dirty.keys()], ["second.txt"]);

    await new RollbackEngine().rollback(options);

    assert.deepEqual(calls, [
      "delete:created.txt",
      "ghost:created.txt",
      "restore:first-long-name.txt",
      "restore:second.txt",
    ]);
    assert.equal(checkpoint.status, "disposed");
    assert.equal(checkpoint.dirty.size, 0);
  });
});
