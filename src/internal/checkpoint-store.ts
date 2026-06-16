import { randomUUID } from "node:crypto";
import path from "node:path";

import { HyperionCapacityError, HyperionPathError } from "../errors.js";
import type {
  Checkpoint,
  CheckpointId,
  DirtyEntry,
  ResolvedHyperionConfig,
  StateManifest,
} from "../types.js";

export interface CheckpointLockState {
  locked: boolean;
}

export type StoredCheckpoint = Checkpoint & {
  lock: CheckpointLockState;
};

export interface CreateCheckpointInput {
  baseline: StateManifest;
  deviceId?: number;
  parentId?: CheckpointId;
}

export interface RestoreCheckpointInput {
  id: CheckpointId;
  baseline: StateManifest;
  dirty: Map<string, DirtyEntry>;
  storageNamespace: string;
  status: "active" | "rolling-back";
  createdAt: number;
  deviceId?: number;
  parentId?: CheckpointId;
}

export class CheckpointStore {
  private readonly checkpoints = new Map<CheckpointId, StoredCheckpoint>();

  public constructor(private readonly config: ResolvedHyperionConfig) {}

  public createCheckpoint(input: CreateCheckpointInput): StoredCheckpoint {
    const id = randomUUID();
    const storageNamespace = path.join(this.config.sessionRoot, id);
    const checkpoint: StoredCheckpoint = {
      id,
      baseline: cloneStateManifest(input.baseline),
      dirty: new Map(),
      storageNamespace,
      status: "active",
      createdAt: Date.now(),
      lock: { locked: false },
    };

    if (input.parentId) {
      checkpoint.parentId = input.parentId;
    }

    if (input.deviceId !== undefined) {
      checkpoint.deviceId = input.deviceId;
    }

    this.checkpoints.set(id, checkpoint);
    return checkpoint;
  }

  public restoreCheckpoint(input: RestoreCheckpointInput): StoredCheckpoint {
    const checkpoint: StoredCheckpoint = {
      id: input.id,
      baseline: cloneStateManifest(input.baseline),
      dirty: new Map(input.dirty),
      storageNamespace: input.storageNamespace,
      status: input.status,
      createdAt: input.createdAt,
      lock: { locked: false },
    };

    if (input.parentId) {
      checkpoint.parentId = input.parentId;
    }

    if (input.deviceId !== undefined) {
      checkpoint.deviceId = input.deviceId;
    }

    this.checkpoints.set(input.id, checkpoint);
    return checkpoint;
  }

  public ensureCapacityAvailable(): void {
    if (this.activeCount >= this.config.maxConcurrentCheckpoints) {
      throw new HyperionCapacityError(
        `Maximum active checkpoints reached: ${this.config.maxConcurrentCheckpoints}`,
      );
    }
  }

  public getCheckpoint(checkpointId: CheckpointId): StoredCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  public getMostRecentActiveCheckpoint(): StoredCheckpoint | undefined {
    let mostRecentCheckpoint: StoredCheckpoint | undefined;

    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.status === "active" || checkpoint.status === "rolling-back") {
        mostRecentCheckpoint = checkpoint;
      }
    }

    return mostRecentCheckpoint;
  }

  public markCheckpointDisposed(checkpointId: CheckpointId): void {
    const checkpoint = this.checkpoints.get(checkpointId);

    if (!checkpoint) {
      throw new HyperionPathError(`Unknown checkpoint: ${checkpointId}`);
    }

    checkpoint.status = "disposed";
  }

  public getDisposedCheckpoints(): StoredCheckpoint[] {
    const disposedCheckpoints: StoredCheckpoint[] = [];

    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.status === "disposed") {
        disposedCheckpoints.push(checkpoint);
      }
    }

    return disposedCheckpoints;
  }

  public collectDisposed(): number {
    let removedCount = 0;

    for (const [checkpointId, checkpoint] of this.checkpoints) {
      if (checkpoint.status === "disposed") {
        this.checkpoints.delete(checkpointId);
        removedCount += 1;
      }
    }

    return removedCount;
  }

  public clear(): void {
    this.checkpoints.clear();
  }

  public get activeCount(): number {
    let count = 0;

    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.status === "active" || checkpoint.status === "rolling-back") {
        count += 1;
      }
    }

    return count;
  }
}

export function cloneStateManifest(manifest: StateManifest): StateManifest {
  const clonedManifest: StateManifest = {
    gitAvailable: manifest.gitAvailable,
    gitIndexEntries: new Map(manifest.gitIndexEntries),
    statEntries: new Map(manifest.statEntries),
    ignoredPatterns: [...manifest.ignoredPatterns],
    capturedAt: manifest.capturedAt,
  };

  if (manifest.gitHead) {
    clonedManifest.gitHead = manifest.gitHead;
  }

  return clonedManifest;
}

export function cloneDirtyMap(dirty: Map<string, DirtyEntry>): Map<string, DirtyEntry> {
  return new Map(dirty);
}
