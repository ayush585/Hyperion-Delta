export type CheckpointId = string;

export type StorageStrategyKind = "tmpfs" | "posix-link" | "pure-manifest";

export interface HyperionConfig {
  workspaceRoot: string;
  useTmpfs?: boolean;
  ignoredPatterns?: string[];
  overrideDefaultIgnores?: boolean;
  enableFsInterceptor?: boolean;
  maxConcurrentCheckpoints?: number;
  sessionRoot?: string;
  useHotBuffer?: boolean;
  hotBufferMaxFileBytes?: number;
  hotBufferMaxTotalBytes?: number;
  hotBufferMaxFiles?: number;
  strictIgnoredWrites?: boolean;
  durableAttemptJournals?: boolean;
}

export interface ResolvedHyperionConfig {
  workspaceRoot: string;
  useTmpfs: boolean;
  ignoredPatterns: string[];
  overrideDefaultIgnores: boolean;
  enableFsInterceptor: boolean;
  maxConcurrentCheckpoints: number;
  sessionRoot: string;
  useHotBuffer: boolean;
  hotBufferMaxFileBytes: number;
  hotBufferMaxTotalBytes: number;
  hotBufferMaxFiles: number;
  strictIgnoredWrites: boolean;
  durableAttemptJournals: boolean;
}

export interface ReconcileResult {
  checkpointId?: CheckpointId;
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

export interface StatLedgerEntry {
  relativePath: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mtimeMs: number;
  mode?: number;
}

export interface GitIndexEntry {
  relativePath: string;
  mode: string;
  objectId: string;
  stage: number;
}

export interface StateManifest {
  gitAvailable: boolean;
  gitHead?: string;
  gitIndexEntries: Map<string, GitIndexEntry>;
  statEntries: Map<string, StatLedgerEntry>;
  ignoredPatterns: string[];
  capturedAt: number;
}

export interface DirtyEntry {
  relativePath: string;
  kind: "created" | "modified" | "deleted" | "renamed" | "metadata";
  fileType: "file" | "directory" | "symlink" | "unknown";
  before?: StatLedgerEntry;
  after?: StatLedgerEntry;
  renameFrom?: string;
  renameTo?: string;
  capturedBy: "vfs" | "track" | "reconcile";
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface Checkpoint {
  id: CheckpointId;
  parentId?: CheckpointId;
  baseline: StateManifest;
  dirty: Map<string, DirtyEntry>;
  storageNamespace: string;
  deviceId?: number;
  status: "active" | "rolling-back" | "disposed";
  createdAt: number;
}

export interface RecoverableAttempt {
  checkpointId: CheckpointId;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  status: Checkpoint["status"];
  strategy: StorageStrategyKind;
  dirtyCount: number;
  journalPath: string;
  gitHead?: string;
}
