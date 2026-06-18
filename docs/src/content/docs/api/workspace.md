---
title: HyperionWorkspace
description:
  Complete API reference for HyperionWorkspace — the core checkpoint,
  reconcile, rollback, and VFS interception API.
---

`HyperionWorkspace` is the low-level SDK entry point. It provides
checkpoint creation, reconciliation, rollback, promotion, VFS
interception, diagnostics, recovery, and patch export.

## Constructor

```ts
new HyperionWorkspace(rootOrConfig: string | HyperionConfig)
```

Accepts a workspace root path string or a full `HyperionConfig` object.
Normalizes paths, rejects non-existent or non-directory roots, and
initializes the session manager, environment profile, strategy selector,
VFS interceptor, and lifecycle hooks.

```ts
// Simple
const workspace = new HyperionWorkspace(process.cwd());

// Full config
const workspace = new HyperionWorkspace({
  workspaceRoot: process.cwd(),
  strictIgnoredWrites: true,
  useHotBuffer: false,
});
```

Throws `HyperionPathError` if the workspace root does not exist or is not
a directory.

## Properties

### `config: ResolvedHyperionConfig`

The resolved configuration with all defaults applied.

```ts
console.log(workspace.config.useHotBuffer); // true
console.log(workspace.config.hotBufferMaxFileBytes); // 262144
```

### `root: string`

The normalized absolute workspace root path.

### `strategy: StorageStrategyKind`

The selected storage strategy: `"tmpfs"`, `"posix-link"`, `"ntfs-link"`,
or `"pure-manifest"`.

### `isDisposed: boolean`

Whether `dispose()` has been called on this workspace.

### `isFsInterceptorInstalled: boolean`

Whether the VFS interceptor is currently patching Node's `fs` module.

## Methods

### `snapshot()`

```ts
snapshot(): Promise<CheckpointId>
```

Creates a checkpoint of the current workspace state. Captures file
metadata for all tracked paths, skipping ignored directories. Runs
capacity GC before allocating a new checkpoint namespace.

```ts
const checkpointId = await workspace.snapshot();
```

Throws `HyperionCapacityError` if `maxConcurrentCheckpoints` is exceeded
and disposed checkpoints cannot be freed. Throws `HyperionError` if the
workspace has been disposed.

### `reconcile(checkpointId?)`

```ts
reconcile(checkpointId?: CheckpointId): Promise<ReconcileResult>
```

Detects filesystem changes outside the VFS interceptor — child processes,
native binaries, shell redirections. Re-runs the hybrid state engine and
diffs against the checkpoint baseline.

```ts
const result = await workspace.reconcile(checkpointId);
// result.created  → string[]
// result.modified → string[]
// result.deleted  → string[]
// result.renamed  → { from, to }[]
```

If no `checkpointId` is given, reconciles the most recent active
checkpoint. Returns an empty result if no active checkpoint exists.

`rollback()` calls `reconcile()` automatically — this cannot be disabled.

### `rollback(checkpointId)`

```ts
rollback(checkpointId: CheckpointId): Promise<void>
```

Restores the workspace to the checkpoint state. Calls `reconcile()`
first, then restores modified/deleted files from backup records, deletes
created files, and cleans ghost directories.

```ts
await workspace.rollback(checkpointId);
```

Throws `HyperionIntegrityError` if a backup record is missing for a
modified or deleted file. Throws `HyperionRollbackError` if the
checkpoint is unknown, disposed, promoted, or locked by another rollback.

### `promote(checkpointId, options?)`

```ts
promote(
  checkpointId: CheckpointId,
  options?: HyperionPromoteOptions
): Promise<HyperionPromotionResult>
```

Accepts the current worktree state in place. Reconciles first, optionally
exports a patch, marks the checkpoint promoted, and frees Hyperion-owned
rollback storage.

```ts
const result = await workspace.promote(checkpointId);
// result.promotedAt, result.dirtyCount, result.storageCleaned

// With patch export
const result = await workspace.promote(checkpointId, { exportPatch: true });
console.log(result.patch);
```

Does **not** run Git. Promoted checkpoints are audit records only. If
patch export fails, the checkpoint remains active and rollback-capable.

Throws `HyperionRollbackError` if the checkpoint is already locked,
disposed, or promoted.

### `dispose()`

```ts
dispose(): Promise<void>
```

Uninstalls the VFS interceptor, cleans active checkpoint storage
namespaces, removes the current session directory, unregisters lifecycle
hooks, and marks the workspace disposed.

```ts
await workspace.dispose();
```

Idempotent — calling multiple times is safe. After disposal, `snapshot()`,
`rollback()`, and `promote()` will throw.

### `track(pathOrPaths)`

```ts
track(pathOrPaths: string | string[]): void
```

Manually registers paths for tracking. Use this for integrations that
cannot use VFS interception. Accepts a single path string or an array.

```ts
workspace.track("src/config.json");
workspace.track(["src/a.ts", "src/b.ts"]);
```

Exact ignored paths can be tracked — they are stored separately and
treated as explicit exceptions during reconciliation.

Throws `HyperionPathError` if paths are empty, non-string, or outside
the workspace.

### `declareToolOutputs(contract)`

```ts
declareToolOutputs(contract: HyperionToolOutputContract): void
```

Declares exact generated or ignored output paths for tools like package
managers, build systems, formatters, and codegen. Declared paths bypass
`strictIgnoredWrites` blocking and are tracked by VFS interception and
`reconcile()`.

```ts
workspace.declareToolOutputs({
  toolName: "vite",
  checkpointId,
  outputs: [
    "node_modules/.cache/vite/deps_metadata.json",
    { path: "dist/manifest.json", optional: true },
  ],
});
```

Contracts are exact-path only. They do not enable recursive scans.

### `getDiagnostics()`

```ts
getDiagnostics(): HyperionDiagnostics
```

Returns a read-only snapshot of strategy, storage, hot-buffer,
Windows volume, checkpoint, and ignored-write diagnostics.

```ts
const diag = workspace.getDiagnostics();
console.log(diag.strategy);
console.log(diag.windowsVolume?.fileSystemName);
console.log(diag.checkpoints[0]?.storage?.hotBuffer?.memoryHits);
```

Does not run Git, shell commands, or filesystem scans. The returned
object is a snapshot — mutations are not reflected back.

### `recoverAttempts()`

```ts
recoverAttempts(): Promise<RecoverableAttempt[]>
```

Inspects durable checkpoint journals and returns summaries with
`canRehydrate` status for each abandoned attempt.

```ts
const attempts = await workspace.recoverAttempts();
// [{ checkpointId, canRehydrate, nonRehydratableReason, ... }]
```

Returns an empty array if `durableAttemptJournals` is disabled.

### `rehydrateAttempt(checkpointId)`

```ts
rehydrateAttempt(checkpointId: CheckpointId): Promise<CheckpointId>
```

Recreates active in-memory checkpoint state from durable journal and
backup metadata. Returns the rehydrated checkpoint ID.

```ts
const checkpointId = await workspace.rehydrateAttempt("ckpt_abc123");
await workspace.rollback(checkpointId);
```

Rejects disposed or promoted attempts, corrupt journals, missing backup
manifests, missing backup files, cross-workspace journals, and volatile
Hot Dirty Buffer memory-only backups.

### `exportPatch(checkpointId)`

```ts
exportPatch(checkpointId: CheckpointId): Promise<string>
```

Emits a Git-compatible unified diff for the active checkpoint's dirty
set. Reconciles first, then produces a text-only patch.

```ts
const patch = await workspace.exportPatch(checkpointId);
```

Throws for binary files, symlinks, and missing backup content. Does not
run Git, commit, merge, push, or dispose the checkpoint.

## Interceptor control

### `installFsInterceptor()`

```ts
installFsInterceptor(): void
```

Installs VFS interception on Node's `fs` module. Patches sync, callback,
promise, and write-stream mutation APIs. Idempotent — calling it when
already installed is safe.

```ts
workspace.installFsInterceptor();
```

### `uninstallFsInterceptor()`

```ts
uninstallFsInterceptor(): void
```

Uninstalls VFS interception and restores the original `fs` functions.
Idempotent — safe to call even if not installed.

```ts
workspace.uninstallFsInterceptor();
```

## Default constants

```ts
DEFAULT_HOT_BUFFER_MAX_FILE_BYTES  = 262144   // 256 KiB
DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES  = 8388608   // 8 MiB
DEFAULT_HOT_BUFFER_MAX_FILES       = 1024
DEFAULT_MAX_CONCURRENT_CHECKPOINTS  = 64
```

## See also

- [HyperionAgentSession API](/api/agent-session/) — the high-level
  session wrapper built on top of HyperionWorkspace
- [Types & Errors](/api/types/) — complete config and type reference
