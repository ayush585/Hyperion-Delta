import type { ReconcileResult, StateManifest } from "../types.js";
import type { StoredCheckpoint } from "./checkpoint-store.js";
import { diffStateManifests } from "./state.js";

export interface ReconciliationEngineInput {
  checkpoint: StoredCheckpoint;
  currentManifest: StateManifest;
}

export class ReconciliationEngine {
  public reconcile(input: ReconciliationEngineInput): ReconcileResult {
    const diff = diffStateManifests(input.checkpoint.baseline, input.currentManifest);
    const currentDiffEntries = [
      ...diff.created,
      ...diff.modified,
      ...diff.deleted,
      ...diff.metadata,
    ];
    const currentDiffPaths = new Set(currentDiffEntries.map((entry) => entry.relativePath));

    for (const entry of currentDiffEntries) {
      const existingEntry = input.checkpoint.dirty.get(entry.relativePath);

      input.checkpoint.dirty.set(
        entry.relativePath,
        existingEntry
          ? {
              ...entry,
              capturedBy: existingEntry.capturedBy,
              firstSeenAt: existingEntry.firstSeenAt,
              lastSeenAt: entry.lastSeenAt,
            }
          : entry,
      );
    }

    for (const [relativePath] of input.checkpoint.dirty) {
      if (
        !currentDiffPaths.has(relativePath) &&
        isPathAtBaseline(input.checkpoint.baseline, input.currentManifest, relativePath)
      ) {
        input.checkpoint.dirty.delete(relativePath);
      }
    }

    return {
      checkpointId: input.checkpoint.id,
      created: diff.created.map((entry) => entry.relativePath),
      modified: [...diff.modified, ...diff.metadata].map((entry) => entry.relativePath),
      deleted: diff.deleted.map((entry) => entry.relativePath),
      renamed: [],
    };
  }
}

function isPathAtBaseline(
  baseline: StateManifest,
  currentManifest: StateManifest,
  relativePath: string,
): boolean {
  const baselineEntry = baseline.statEntries.get(relativePath);
  const currentEntry = currentManifest.statEntries.get(relativePath);

  if (!baselineEntry && !currentEntry) {
    return true;
  }

  if (!baselineEntry || !currentEntry) {
    return false;
  }

  return (
    baselineEntry.type === currentEntry.type &&
    baselineEntry.size === currentEntry.size &&
    baselineEntry.mtimeMs === currentEntry.mtimeMs &&
    baselineEntry.mode === currentEntry.mode
  );
}
