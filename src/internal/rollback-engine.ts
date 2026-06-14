import { HyperionIntegrityError, HyperionRollbackError } from "../errors.js";
import type { DirtyEntry } from "../types.js";
import type { StoredCheckpoint } from "./checkpoint-store.js";
import { GhostDirectoryCleaner } from "./ghost-directory-cleaner.js";
import type { PureManifestStrategy } from "./pure-manifest-strategy.js";

export interface RollbackEngineOptions {
  checkpoint: StoredCheckpoint;
  storage: PureManifestStrategy;
  ghostDirectoryCleaner: GhostDirectoryCleaner;
  reconcile: () => Promise<void>;
}

export class RollbackEngine {
  public async rollback(options: RollbackEngineOptions): Promise<void> {
    const { checkpoint, storage, ghostDirectoryCleaner, reconcile } = options;

    if (checkpoint.status === "disposed") {
      throw new HyperionRollbackError(`Checkpoint is already disposed: ${checkpoint.id}`);
    }

    if (checkpoint.lock.locked || checkpoint.status === "rolling-back") {
      throw new HyperionRollbackError(`Checkpoint is already rolling back: ${checkpoint.id}`);
    }

    checkpoint.lock.locked = true;
    checkpoint.status = "rolling-back";

    try {
      await reconcile();
      this.restoreDirtyEntries(checkpoint, storage, ghostDirectoryCleaner);
      checkpoint.status = "disposed";
    } catch (error) {
      checkpoint.status = "active";
      throw error;
    } finally {
      checkpoint.lock.locked = false;
    }
  }

  private restoreDirtyEntries(
    checkpoint: StoredCheckpoint,
    storage: PureManifestStrategy,
    ghostDirectoryCleaner: GhostDirectoryCleaner,
  ): void {
    const createdEntries = this.dirtyEntriesByKind(checkpoint, "created");
    const restoreEntries = [
      ...this.dirtyEntriesByKind(checkpoint, "modified"),
      ...this.dirtyEntriesByKind(checkpoint, "deleted"),
      ...this.dirtyEntriesByKind(checkpoint, "metadata"),
    ];

    for (const entry of createdEntries) {
      storage.deleteCreatedPath(entry.relativePath);
      ghostDirectoryCleaner.cleanupAfterCreatedPath(entry.relativePath);
    }

    for (const entry of restoreEntries) {
      const backupRecord = storage.getBackupRecord(entry.relativePath);

      if (!backupRecord && entry.fileType === "directory" && entry.kind !== "deleted") {
        continue;
      }

      if (!backupRecord) {
        throw new HyperionIntegrityError(`Missing backup record for ${entry.relativePath}`);
      }

      storage.restoreFile(entry.relativePath);
    }
  }

  private dirtyEntriesByKind(
    checkpoint: StoredCheckpoint,
    kind: DirtyEntry["kind"],
  ): DirtyEntry[] {
    return [...checkpoint.dirty.values()]
      .filter((entry) => entry.kind === kind)
      .sort((first, second) => second.relativePath.length - first.relativePath.length);
  }
}
