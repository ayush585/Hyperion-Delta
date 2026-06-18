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

    const renamePairs = detectRenamePairs(diff.created, diff.deleted);
    const renamedCreatedPaths = new Set(renamePairs.map((pair) => pair.created.relativePath));
    const renamedDeletedPaths = new Set(renamePairs.map((pair) => pair.deleted.relativePath));

    return {
      checkpointId: input.checkpoint.id,
      created: diff.created
        .filter((entry) => !renamedCreatedPaths.has(entry.relativePath))
        .map((entry) => entry.relativePath),
      modified: [...diff.modified, ...diff.metadata].map((entry) => entry.relativePath),
      deleted: diff.deleted
        .filter((entry) => !renamedDeletedPaths.has(entry.relativePath))
        .map((entry) => entry.relativePath),
      renamed: renamePairs.map((pair) => ({
        from: pair.deleted.relativePath,
        to: pair.created.relativePath,
      })),
    };
  }
}

function detectRenamePairs(
  createdEntries: ReadonlyArray<{ relativePath: string; after?: { type: string; size: number; mtimeMs: number; mode?: number } }>,
  deletedEntries: ReadonlyArray<{ relativePath: string; before?: { type: string; size: number; mtimeMs: number; mode?: number } }>,
): Array<{
  created: { relativePath: string };
  deleted: { relativePath: string };
}> {
  const createdBySignature = new Map<string, typeof createdEntries>();
  const deletedBySignature = new Map<string, typeof deletedEntries>();

  for (const createdEntry of createdEntries) {
    const signature = statSignature(createdEntry.after);

    if (!signature) {
      continue;
    }

    const existing = createdBySignature.get(signature) ?? [];
    createdBySignature.set(signature, [...existing, createdEntry]);
  }

  for (const deletedEntry of deletedEntries) {
    const signature = statSignature(deletedEntry.before);

    if (!signature) {
      continue;
    }

    const existing = deletedBySignature.get(signature) ?? [];
    deletedBySignature.set(signature, [...existing, deletedEntry]);
  }

  const renamePairs: Array<{
    created: { relativePath: string };
    deleted: { relativePath: string };
  }> = [];

  for (const [signature, createdCandidates] of createdBySignature) {
    const deletedCandidates = deletedBySignature.get(signature);

    if (!deletedCandidates || createdCandidates.length !== 1 || deletedCandidates.length !== 1) {
      continue;
    }

    const createdCandidate = createdCandidates[0];
    const deletedCandidate = deletedCandidates[0];

    if (!createdCandidate || !deletedCandidate) {
      continue;
    }

    renamePairs.push({
      created: createdCandidate,
      deleted: deletedCandidate,
    });
  }

  return renamePairs.sort((first, second) =>
    first.deleted.relativePath.localeCompare(second.deleted.relativePath) ||
    first.created.relativePath.localeCompare(second.created.relativePath),
  );
}

function statSignature(entry: { type: string; size: number; mtimeMs: number; mode?: number } | undefined): string | undefined {
  if (!entry) {
    return undefined;
  }

  return `${entry.type}|${entry.size}|${entry.mtimeMs}|${entry.mode ?? -1}`;
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
