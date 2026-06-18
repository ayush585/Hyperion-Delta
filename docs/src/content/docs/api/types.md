---
title: Types & Errors
description:
  Complete reference for all public types, interfaces, config options,
  and error classes exported by hyperion-delta.
---

## Config

### `HyperionConfig`

```ts
interface HyperionConfig {
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
```

| Field | Type | Default | Description |
|---|---|---|---|
| `workspaceRoot` | `string` | **required** | Absolute or relative path to the workspace |
| `useTmpfs` | `boolean` | `true` | Enable tmpfs strategy on Linux/WSL2 |
| `ignoredPatterns` | `string[]` | `[]` | Additional glob patterns to ignore |
| `overrideDefaultIgnores` | `boolean` | `false` | Replace default ignores instead of extending |
| `enableFsInterceptor` | `boolean` | `true` | Auto-install VFS interception |
| `maxConcurrentCheckpoints` | `number` | `64` | Max active checkpoints before capacity error |
| `sessionRoot` | `string` | `".hyperion/checkpoints"` | Checkpoint storage directory |
| `useHotBuffer` | `boolean` | `true` | Enable in-memory small-file cache |
| `hotBufferMaxFileBytes` | `number` | `262144` (256 KiB) | Max per-file size in buffer |
| `hotBufferMaxTotalBytes` | `number` | `8388608` (8 MiB) | Max total buffer size |
| `hotBufferMaxFiles` | `number` | `1024` | Max files in buffer |
| `strictIgnoredWrites` | `boolean` | `false` | Throw on writes into ignored paths |
| `durableAttemptJournals` | `boolean` | `true` | Write checkpoint metadata to disk |

### `ResolvedHyperionConfig`

The full config with all defaults applied. Same fields as
`HyperionConfig` but all optional fields are now required.

### `HyperionPromoteOptions`

```ts
interface HyperionPromoteOptions {
  exportPatch?: boolean;
}
```

Passed to `promote()`. When `exportPatch` is `true`, the promotion result
includes a Git-compatible unified diff of the dirty set.

### `HyperionSnapshotOptions`

```ts
interface HyperionSnapshotOptions {
  parentId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  createdBy?: HyperionCheckpointCreatedBy;
}
```

Used by `snapshot(options?)`. All fields are optional.

- `parentId` requires an active checkpoint.
- `branchId`, `subagentId`, and `agentId` must be non-empty strings.

### `HyperionCheckpointCreatedBy`

```ts
type HyperionCheckpointCreatedBy =
  | "snapshot"
  | "fork"
  | "run-attempt"
  | "run-in-branch"
  | "rehydrate"
  | "unknown";
```

## Checkpoint types

### `CheckpointId`

```ts
type CheckpointId = string;
```

A unique identifier for a checkpoint, returned by `snapshot()`.

### `HyperionCheckpointSummary`

```ts
interface HyperionCheckpointSummary {
  checkpointId: CheckpointId;
  parentId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  createdBy?: HyperionCheckpointCreatedBy;
  status: "active" | "rolling-back" | "disposed" | "promoted";
  createdAt: number;
  source: "active" | "journal";
}
```

Returned by lineage/head APIs:

- `getCheckpointLineage(checkpointId)`
- `listCheckpointChildren(parentId, options?)`
- `listBranchHeads(filter?)`
- `listSubagentHeads(filter?)`

### `HyperionCheckpointHeadFilter`

```ts
interface HyperionCheckpointHeadFilter {
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  includeInactive?: boolean;
}
```

Optional filter for `listBranchHeads()` and `listSubagentHeads()`.

### `StorageStrategyKind`

```ts
type StorageStrategyKind =
  | "tmpfs"
  | "posix-link"
  | "ntfs-link"
  | "pure-manifest";
```

The selected rollback storage strategy. Determined automatically by
environment discovery during workspace construction.

## Reconciliation result

### `ReconcileResult`

```ts
interface ReconcileResult {
  checkpointId?: CheckpointId;
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}
```

Returned by `reconcile()`. Lists all paths that changed since the
checkpoint, categorized by mutation type.

## Promotion result

### `HyperionPromotionResult`

```ts
interface HyperionPromotionResult {
  checkpointId: CheckpointId;
  promotedAt: number;
  dirtyCount: number;
  reconcileResult: ReconcileResult;
  storageCleaned: boolean;
  patch?: string;
}
```

Returned by `promote()`. Includes the patch when `exportPatch` was
requested, and whether storage was successfully cleaned.

### `HyperionPromoteBranchOptions`

```ts
interface HyperionPromoteBranchOptions extends HyperionPromoteOptions {
  targetCheckpointId?: CheckpointId;
  conflictMode?: HyperionBranchConflictMode;
}
```

### `HyperionBranchConflictMode`

```ts
type HyperionBranchConflictMode = "reject";
```

### `HyperionBranchPathConflict`

```ts
interface HyperionBranchPathConflict {
  relativePath: string;
  sourceCheckpointId: CheckpointId;
  targetCheckpointId: CheckpointId;
  sourceKind: DirtyEntry["kind"];
  targetKind: DirtyEntry["kind"];
  sourceAgentId?: string;
  targetAgentId?: string;
}
```

### `HyperionBranchMergeResult`

```ts
interface HyperionBranchMergeResult {
  sourceCheckpointId: CheckpointId;
  targetCheckpointId?: CheckpointId;
  conflictMode: HyperionBranchConflictMode;
  mergedAt: number;
  appliedPaths: string[];
  conflicts: HyperionBranchPathConflict[];
}
```

### `HyperionBranchPromotionResult`

```ts
interface HyperionBranchPromotionResult extends HyperionPromotionResult {
  merge: HyperionBranchMergeResult;
}
```

## Diagnostics

### `HyperionDiagnostics`

```ts
interface HyperionDiagnostics {
  strategy: StorageStrategyKind;
  activeCheckpointCount: number;
  checkpoints: HyperionCheckpointDiagnostics[];
  ignoredWrites: HyperionIgnoredWriteEvent[];
  isDisposed: boolean;
  windowsVolume?: HyperionWindowsVolumeDiagnostics;
}
```

### `HyperionAgentSessionDiagnostics`

```ts
interface HyperionAgentSessionDiagnostics extends HyperionDiagnostics {
  lastReconcileResult?: ReconcileResult;
  lastRollbackMs?: number;
}
```

### `HyperionCheckpointDiagnostics`

```ts
interface HyperionCheckpointDiagnostics {
  checkpointId: CheckpointId;
  parentId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  createdBy?: HyperionCheckpointCreatedBy;
  createdAt?: number;
  status: "active" | "rolling-back" | "disposed" | "promoted";
  lineage?: HyperionCheckpointSummary[];
  storage?: HyperionStorageDiagnostics;
}
```

### `HyperionStorageDiagnostics`

```ts
interface HyperionStorageDiagnostics {
  physicalStrategy: StorageStrategyKind;
  backupRecordCount: number;
  hotBuffer: HyperionHotBufferDiagnostics;
  posixLink?: { linkModeActive: boolean };
  ntfsLink?: { linkModeActive: boolean };
  tmpfs?: { active: boolean };
}
```

### `HyperionHotBufferDiagnostics`

```ts
interface HyperionHotBufferDiagnostics {
  enabled: boolean;
  memoryHits: number;
  spills: number;
  bytesUsed: number;
  filesUsed: number;
}
```

### `HyperionWindowsVolumeDiagnostics`

```ts
interface HyperionWindowsVolumeDiagnostics {
  fileSystemName?: string;
  isDevDrive: boolean;
  devDriveTrusted: boolean;
  hardLinkCapable: boolean;
  blockCloneCandidate: boolean;
}
```

### `HyperionIgnoredWriteEvent`

```ts
interface HyperionIgnoredWriteEvent {
  relativePath: string;
  kind: VfsMutationKind;
  capturedAt: number;
  action: "blocked" | "ignored" | "declared";
}
```

## Tool output contracts

### `HyperionToolOutputContract`

```ts
interface HyperionToolOutputContract {
  toolName: string;
  outputs: HyperionToolOutputPath[];
  checkpointId?: CheckpointId;
}
```

### `HyperionToolOutputPath`

```ts
type HyperionToolOutputPath =
  | string
  | { path: string; optional?: boolean };
```

## Recovery

### `RecoverableAttempt`

```ts
interface RecoverableAttempt {
  checkpointId: CheckpointId;
  parentId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
  createdBy?: HyperionCheckpointCreatedBy;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "rolling-back" | "disposed" | "promoted";
  strategy: StorageStrategyKind;
  dirtyCount: number;
  journalPath: string;
  canRehydrate: boolean;
  nonRehydratableReason?: string;
  gitHead?: string;
}
```

Returned by `recoverAttempts()`. Describes an abandoned checkpoint and
whether it can be rehydrated.

## Agent session types

### `HyperionAttemptContext`

```ts
interface HyperionAttemptContext {
  checkpointId: CheckpointId;
  workspace: HyperionWorkspace;
  reconcile(): Promise<ReconcileResult>;
  exec(
    command: string,
    args?: string[],
    options?: HyperionExecOptions
  ): Promise<HyperionExecResult>;
}
```

Passed to `runAttempt()` callbacks.

### `HyperionBranchContext`

```ts
interface HyperionBranchContext {
  checkpointId: CheckpointId;
  workspace: HyperionWorkspace;
  reconcile(): Promise<ReconcileResult>;
}
```

Passed to `runInBranch()` callbacks.

### `HyperionBranchRunResult<T>`

```ts
interface HyperionBranchRunResult<T> {
  checkpointId: CheckpointId;
  result: T;
  reconcileResult: ReconcileResult;
}
```

### `HyperionAttemptResult<T>`

```ts
interface HyperionAttemptResult<T> {
  checkpointId: CheckpointId;
  result: T;
  reconcileResult?: ReconcileResult;
  rolledBack: boolean;
  rollbackMs?: number;
}
```

### `HyperionAttemptOptions`

```ts
interface HyperionAttemptOptions {
  rollbackOnThrow?: boolean;
  reconcileOnSuccess?: boolean;
  parentCheckpointId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
}
```

### `HyperionExecOptions`

```ts
interface HyperionExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: import("node:child_process").StdioOptions;
  rejectOnNonZero?: boolean;
  captureOutput?: boolean;
  timeoutMs?: number;
}
```

### `HyperionExecResult`

```ts
interface HyperionExecResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}
```

## Error hierarchy

```
Error
├── HyperionError
│   ├── HyperionBranchConflictError
│   ├── HyperionCapacityError
│   ├── HyperionIntegrityError
│   ├── HyperionPathError
│   │   └── HyperionIgnoredPathError
│   └── HyperionRollbackError
├── HyperionExecError
│   (thrown by HyperionAgentSession.exec())
├── HyperionAttemptInProgressError
│   (thrown by HyperionAgentSession.runAttempt())
└── HyperionAttemptRollbackError
    (thrown by HyperionAgentSession.runAttempt())
```

### `HyperionError`

```ts
class HyperionError extends Error {
  code: HyperionErrorCode;
}
```

Base error class. All Hyperion errors have a `code` property from
`HyperionErrorCode`:

```ts
type HyperionErrorCode =
  | "HYPERION_CAPACITY"
  | "HYPERION_BRANCH_CONFLICT"
  | "HYPERION_INTEGRITY"
  | "HYPERION_IGNORED_PATH"
  | "HYPERION_PATH"
  | "HYPERION_ROLLBACK"
  | "HYPERION_NOT_IMPLEMENTED";
```

### `HyperionCapacityError extends HyperionError`

Thrown by `snapshot()` when `maxConcurrentCheckpoints` is exceeded and
disposed checkpoints cannot be collected.

### `HyperionBranchConflictError extends HyperionError`

Thrown by `promoteBranch()` and `dropBranch()` when active branch dirty
sets overlap and `conflictMode` is reject-only.

### `HyperionIntegrityError extends HyperionError`

Thrown by `rollback()` when a backup record is missing for a modified or
deleted file, or backup content is corrupted. Indicates that safe
rollback is impossible.

### `HyperionPathError extends HyperionError`

Thrown for invalid paths — missing workspace root, paths outside the
workspace, empty path strings, path traversal attempts.

### `HyperionIgnoredPathError extends HyperionPathError`

Thrown by the VFS interceptor when `strictIgnoredWrites` is enabled and
a write targets an ignored path. Includes the `relativePath` that caused
the error.

### `HyperionRollbackError extends HyperionError`

Thrown by `rollback()` and `promote()` for unknown, disposed, promoted,
or concurrently locked checkpoints.

### `HyperionExecError extends Error`

Thrown by `HyperionAgentSession.exec()` when `rejectOnNonZero` is `true`
(default) and the child process exits with a non-zero code. Includes the
full `HyperionExecResult`.

### `HyperionExecTimeoutError extends Error`

Thrown by `HyperionAgentSession.exec()` when `timeoutMs` is exceeded.
Includes the `command`, `timeoutMs`, and `code = "HYPERION_EXEC_TIMEOUT"`.

### `HyperionExecOptionsError extends Error`

Thrown by `HyperionAgentSession.exec()` when option validation fails, such
as non-finite or negative `timeoutMs` values.

### `HyperionAttemptContextError extends Error`

Thrown by `runAttempt()` when the callback throws a primitive value (for
example a string or number) instead of an `Error`. The original value is
available on `.value`.

### `HyperionAttemptInProgressError extends Error`

Thrown by `runAttempt()` when another `runAttempt()` is already active in
the same `HyperionAgentSession`. Exposes
`code = "HYPERION_ATTEMPT_IN_PROGRESS"` and may include
`activeCheckpointId`.

### `HyperionAttemptRollbackError extends Error`

Thrown by `HyperionAgentSession.runAttempt()` on double-fault: the
callback threw and the subsequent rollback also failed. Exposes both the
attempt error and the rollback error for inspection.

### `HyperionAgentSessionErrorCode`

```ts
type HyperionAgentSessionErrorCode =
  | "HYPERION_EXEC"
  | "HYPERION_EXEC_OPTIONS"
  | "HYPERION_EXEC_TIMEOUT"
  | "HYPERION_ATTEMPT_IN_PROGRESS"
  | "HYPERION_ATTEMPT_CONTEXT"
  | "HYPERION_ATTEMPT_ROLLBACK";
```

## Default constants

```ts
DEFAULT_HOT_BUFFER_MAX_FILE_BYTES   = 262144
DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES  = 8388608
DEFAULT_HOT_BUFFER_MAX_FILES        = 1024
DEFAULT_MAX_CONCURRENT_CHECKPOINTS  = 64
```

## See also

- [HyperionWorkspace API](/api/workspace/) — core workspace methods
- [HyperionAgentSession API](/api/agent-session/) — session wrapper
  methods and attempt lifecycle
