import type {
  DirtyEntry,
  HyperionBranchConflictMode,
  HyperionBranchMergeResult,
  HyperionBranchPathConflict,
} from "../types.js";
import type { StoredCheckpoint } from "./checkpoint-store.js";

export interface BranchMergePlanInput {
  source: StoredCheckpoint;
  target?: StoredCheckpoint;
  contenders: StoredCheckpoint[];
  conflictMode: HyperionBranchConflictMode;
}

export class BranchMergeEngine {
  public plan(input: BranchMergePlanInput): HyperionBranchMergeResult {
    const sourceEntries = [...input.source.dirty.values()].sort((first, second) =>
      first.relativePath.localeCompare(second.relativePath),
    );
    const conflictPaths = new Set<string>();
    const conflicts: HyperionBranchPathConflict[] = [];
    const orderedContenders = [...input.contenders].sort((first, second) =>
      first.id.localeCompare(second.id),
    );

    for (const sourceDirtyEntry of sourceEntries) {
      const relativePath = sourceDirtyEntry.relativePath;

      for (const contender of orderedContenders) {
        const contenderDirtyEntry = contender.dirty.get(relativePath);

        if (!contenderDirtyEntry) {
          continue;
        }

        if (isDirtyOutcomeCompatible(sourceDirtyEntry, contenderDirtyEntry)) {
          continue;
        }

        conflictPaths.add(relativePath);
        const conflict: HyperionBranchPathConflict = {
          relativePath,
          sourceCheckpointId: input.source.id,
          targetCheckpointId: contender.id,
          sourceKind: sourceDirtyEntry.kind,
          targetKind: contenderDirtyEntry.kind,
        };
        const sourceAgentId = resolveAgentId(input.source);
        const targetAgentId = resolveAgentId(contender);

        if (sourceAgentId !== undefined) {
          conflict.sourceAgentId = sourceAgentId;
        }

        if (targetAgentId !== undefined) {
          conflict.targetAgentId = targetAgentId;
        }

        conflicts.push(conflict);
      }
    }

    const appliedEntries = sourceEntries
      .filter((entry) => !conflictPaths.has(entry.relativePath))
      .sort(compareDirtyApplyOrder);

    return {
      sourceCheckpointId: input.source.id,
      ...(input.target === undefined ? {} : { targetCheckpointId: input.target.id }),
      conflictMode: input.conflictMode,
      mergedAt: Date.now(),
      appliedPaths: appliedEntries.map((entry) => entry.relativePath),
      conflicts,
    };
  }
}

function resolveAgentId(checkpoint: StoredCheckpoint): string | undefined {
  return checkpoint.agentId ?? checkpoint.subagentId;
}

function isDirtyOutcomeCompatible(source: DirtyEntry, target: DirtyEntry): boolean {
  if (source.kind !== target.kind) {
    return false;
  }

  if (source.fileType !== target.fileType) {
    return false;
  }

  if (source.kind === "created" || source.kind === "modified" || source.kind === "metadata") {
    if (!source.after || !target.after) {
      return false;
    }
  }

  if (source.kind === "deleted") {
    if (!source.before || !target.before) {
      return false;
    }
  }

  if (source.kind === "renamed") {
    if (!source.renameFrom || !source.renameTo || !target.renameFrom || !target.renameTo) {
      return false;
    }
  }

  return dirtyEntrySignature(source) === dirtyEntrySignature(target);
}

function dirtyEntrySignature(entry: DirtyEntry): string {
  return JSON.stringify({
    kind: entry.kind,
    fileType: entry.fileType,
    renameFrom: entry.renameFrom,
    renameTo: entry.renameTo,
    before: statEntrySignature(entry.before),
    after: statEntrySignature(entry.after),
  });
}

function statEntrySignature(entry: DirtyEntry["before"]):
  | {
      type: string;
      size: number;
      mtimeMs: number;
      mode?: number;
    }
  | undefined {
  if (!entry) {
    return undefined;
  }

  return {
    type: entry.type,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
  };
}

function compareDirtyApplyOrder(first: DirtyEntry, second: DirtyEntry): number {
  const kindRankDifference = getDirtyKindRank(first.kind) - getDirtyKindRank(second.kind);

  if (kindRankDifference !== 0) {
    return kindRankDifference;
  }

  if (first.kind === "deleted" && second.kind === "deleted") {
    const depthDifference = pathDepth(second.relativePath) - pathDepth(first.relativePath);

    if (depthDifference !== 0) {
      return depthDifference;
    }
  }

  return first.relativePath.localeCompare(second.relativePath);
}

function getDirtyKindRank(kind: DirtyEntry["kind"]): number {
  if (kind === "deleted") {
    return 0;
  }

  if (kind === "created") {
    return 1;
  }

  if (kind === "modified") {
    return 2;
  }

  if (kind === "metadata") {
    return 3;
  }

  return 4;
}

function pathDepth(relativePath: string): number {
  return relativePath.split("/").length;
}
