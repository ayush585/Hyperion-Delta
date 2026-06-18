export type CheckpointId = string;

export type StorageStrategyKind = "tmpfs" | "posix-link" | "ntfs-link" | "pure-manifest";

export type VfsMutationKind = "write" | "delete" | "metadata" | "mkdir";

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

export interface HyperionSnapshotOptions {
  parentId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  createdBy?: HyperionCheckpointCreatedBy;
}

export type HyperionCheckpointCreatedBy =
  | "snapshot"
  | "fork"
  | "run-attempt"
  | "run-in-branch"
  | "rehydrate"
  | "unknown";

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
  capturedBy: "vfs" | "track" | "reconcile" | "tool-contract";
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface Checkpoint {
  id: CheckpointId;
  parentId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  createdBy?: HyperionCheckpointCreatedBy;
  baseline: StateManifest;
  dirty: Map<string, DirtyEntry>;
  storageNamespace: string;
  deviceId?: number;
  status: "active" | "rolling-back" | "disposed" | "promoted";
  createdAt: number;
}

export interface HyperionCheckpointSummary {
  checkpointId: CheckpointId;
  parentId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  createdBy?: HyperionCheckpointCreatedBy;
  status: Checkpoint["status"];
  createdAt: number;
  source: "active" | "journal";
}

export interface HyperionCheckpointHeadFilter {
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  includeInactive?: boolean;
}

export interface RecoverableAttempt {
  checkpointId: CheckpointId;
  parentId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  createdBy?: HyperionCheckpointCreatedBy;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  status: Checkpoint["status"];
  strategy: StorageStrategyKind;
  dirtyCount: number;
  journalPath: string;
  canRehydrate: boolean;
  nonRehydratableReason?: string;
  gitHead?: string;
}

export interface HyperionPromoteOptions {
  exportPatch?: boolean;
}

export type HyperionBranchConflictMode = "reject";

export interface HyperionBranchPathConflict {
  relativePath: string;
  sourceCheckpointId: CheckpointId;
  targetCheckpointId: CheckpointId;
  sourceKind: DirtyEntry["kind"];
  targetKind: DirtyEntry["kind"];
  sourceAgentId?: string;
  targetAgentId?: string;
}

export interface HyperionBranchMergeResult {
  sourceCheckpointId: CheckpointId;
  targetCheckpointId?: CheckpointId;
  conflictMode: HyperionBranchConflictMode;
  mergedAt: number;
  appliedPaths: string[];
  conflicts: HyperionBranchPathConflict[];
}

export interface HyperionPromoteBranchOptions extends HyperionPromoteOptions {
  targetCheckpointId?: CheckpointId;
  conflictMode?: HyperionBranchConflictMode;
}

export interface HyperionBranchPromotionResult extends HyperionPromotionResult {
  merge: HyperionBranchMergeResult;
}

export interface HyperionPromotionResult {
  checkpointId: CheckpointId;
  promotedAt: number;
  dirtyCount: number;
  reconcileResult: ReconcileResult;
  storageCleaned: boolean;
  patch?: string;
}

export interface HyperionHotBufferDiagnostics {
  enabled: boolean;
  memoryHits: number;
  spills: number;
  bytesUsed: number;
  filesUsed: number;
}

export interface HyperionStorageDiagnostics {
  physicalStrategy: StorageStrategyKind;
  backupRecordCount: number;
  hotBuffer: HyperionHotBufferDiagnostics;
  posixLink?: {
    linkModeActive: boolean;
  };
  ntfsLink?: {
    linkModeActive: boolean;
  };
  tmpfs?: {
    active: boolean;
  };
}

export interface HyperionWindowsVolumeDiagnostics {
  fileSystemName?: string | undefined;
  isDevDrive: boolean;
  devDriveTrusted: boolean;
  hardLinkCapable: boolean;
  blockCloneCandidate: boolean;
}

export interface HyperionIgnoredWriteEvent {
  relativePath: string;
  kind: VfsMutationKind;
  capturedAt: number;
  action: "blocked" | "ignored" | "declared";
}

export interface HyperionCheckpointDiagnostics {
  checkpointId: CheckpointId;
  parentId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  createdBy?: HyperionCheckpointCreatedBy;
  createdAt?: number;
  status: Checkpoint["status"];
  lineage?: HyperionCheckpointSummary[];
  storage?: HyperionStorageDiagnostics;
}

export interface HyperionDiagnostics {
  strategy: StorageStrategyKind;
  activeCheckpointCount: number;
  checkpoints: HyperionCheckpointDiagnostics[];
  ignoredWrites: HyperionIgnoredWriteEvent[];
  isDisposed: boolean;
  windowsVolume?: HyperionWindowsVolumeDiagnostics;
}

export type HyperionToolOutputPath = string | {
  path: string;
  optional?: boolean;
};

export interface HyperionToolOutputContract {
  toolName: string;
  outputs: HyperionToolOutputPath[];
  checkpointId?: CheckpointId;
}
