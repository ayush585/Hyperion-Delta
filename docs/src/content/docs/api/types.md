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

## Checkpoint types

### `CheckpointId`

```ts
type CheckpointId = string;
```

A unique identifier for a checkpoint, returned by `snapshot()`.

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
  status: "active" | "rolling-back" | "disposed" | "promoted";
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
│   ├── HyperionCapacityError
│   ├── HyperionIntegrityError
│   ├── HyperionPathError
│   │   └── HyperionIgnoredPathError
│   └── HyperionRollbackError
├── HyperionExecError
│   (thrown by HyperionAgentSession.exec())
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
  | "HYPERION_INTEGRITY"
  | "HYPERION_IGNORED_PATH"
  | "HYPERION_PATH"
  | "HYPERION_ROLLBACK"
  | "HYPERION_NOT_IMPLEMENTED";
```

### `HyperionCapacityError extends HyperionError`

Thrown by `snapshot()` when `maxConcurrentCheckpoints` is exceeded and
disposed checkpoints cannot be collected.

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
