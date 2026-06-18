---
title: Agent Session
description:
  API reference for HyperionAgentSession — the high-level Prettiflow-oriented
  wrapper with automatic snapshot, exec, rollback, and diagnostics.
---

`HyperionAgentSession` wraps `HyperionWorkspace` with a higher-level
attempt lifecycle. It installs VFS interception by default, exposes the
selected strategy, records reconciliation and rollback diagnostics, and
provides an autopilot `runAttempt()` flow.

## Constructor

```ts
new HyperionAgentSession(rootOrConfig: string | HyperionConfig)
```

Creates a `HyperionWorkspace` internally and installs the VFS interceptor
by default (respects `enableFsInterceptor` in config).

```ts
const session = new HyperionAgentSession(process.cwd());
const session = new HyperionAgentSession({
  workspaceRoot: process.cwd(),
  strictIgnoredWrites: true,
});
```

## Properties

### `workspace: HyperionWorkspace`

The underlying workspace. Use this for low-level operations not covered
by the session API.

### `strategy: StorageStrategyKind`

The selected storage strategy from the underlying workspace.

### `diagnostics: HyperionAgentSessionDiagnostics`

Getter. Returns `getDiagnostics()` including last reconcile result and
rollback timing.

### `lastReconcileResult: ReconcileResult | undefined`

The reconcile result from the most recent `reconcile()` or `runAttempt()`
call.

### `lastRollbackMs: number | undefined`

Rollback duration in milliseconds from the most recent `rollback()` call.

### `isDisposed: boolean`

Whether the underlying workspace has been disposed.

## Methods

### `runAttempt(callback, options?)`

```ts
runAttempt<T>(
  callback: (context: HyperionAttemptContext) => T | Promise<T>,
  options?: HyperionAttemptOptions
): Promise<HyperionAttemptResult<T>>
```

The autopilot attempt runner. Snapshots the workspace, executes the
callback, reconciles on success, and rolls back on failure.

If another `runAttempt()` is already active in the same session, this
throws `HyperionAttemptInProgressError` immediately.

```ts
const attempt = await session.runAttempt(async ({ exec }) => {
  await exec("npm", ["test"]);
  return { passed: true };
});

// attempt.checkpointId → string
// attempt.result       → { passed: true }
// attempt.rolledBack   → false
// attempt.reconcileResult → ReconcileResult
```

The callback receives a `HyperionAttemptContext`:

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

**Options:**

```ts
interface HyperionAttemptOptions {
  rollbackOnThrow?: boolean;   // default: true
  reconcileOnSuccess?: boolean; // default: true
  parentCheckpointId?: CheckpointId;
  branchId?: string;
  subagentId?: string;
  agentId?: string;
}
```

When `parentCheckpointId` is set, `runAttempt()` uses workspace
`fork(parentCheckpointId, ...)` semantics: it requires an active parent,
inherits lineage tags by default, and applies any explicit `branchId` or
`subagentId`/`agentId` overrides.

**Result:**

```ts
interface HyperionAttemptResult<T> {
  checkpointId: CheckpointId;
  result: T;
  reconcileResult?: ReconcileResult;
  rolledBack: boolean;
  rollbackMs?: number;
}
```

Throws `HyperionAttemptRollbackError` if the callback throws **and**
rollback also fails. This is a double-fault — both the attempt and
the rollback failed.

### `exec(command, args?, options?)`

```ts
exec(
  command: string,
  args?: string[],
  options?: HyperionExecOptions
): Promise<HyperionExecResult>
```

Runs an explicit executable with an argument array. Uses `spawn` with
`shell: false`. Does **not** reconcile automatically — use this outside
`runAttempt()` for one-off commands.

```ts
const result = await session.exec("npx", ["tsc", "--noEmit"]);
// result.exitCode → 0 | null
// result.stdout   → string (when captureOutput: true)
```

Inside `runAttempt()`, use the context `exec()` instead — it reconciles
the active checkpoint after the process exits.

**Options:**

```ts
interface HyperionExecOptions {
  cwd?: string;              // default: workspace root
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;      // default: "inherit"
  rejectOnNonZero?: boolean; // default: true
  captureOutput?: boolean;   // default: false
  timeoutMs?: number;        // default: 300000 (5 minutes), 0 disables timeout
}
```

**Result:**

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

Throws `HyperionExecError` when `rejectOnNonZero` is true and
`exitCode !== 0`. Throws `HyperionExecTimeoutError` when `timeoutMs` is
exceeded. Throws `HyperionExecOptionsError` when `timeoutMs` is invalid.

### `snapshot(options?)`

```ts
snapshot(options?: HyperionSnapshotOptions): Promise<CheckpointId>
```

Delegates to `workspace.snapshot()`.

### `fork(parentCheckpointId, options?)`

```ts
fork(
  parentCheckpointId?: CheckpointId,
  options?: Omit<HyperionSnapshotOptions, "parentId">
): Promise<CheckpointId>
```

Delegates to `workspace.fork()`.

### `runInBranch(branchCheckpointId, callback)`

```ts
runInBranch<T>(
  branchCheckpointId: CheckpointId,
  callback: (context: HyperionBranchContext) => T | Promise<T>
): Promise<HyperionBranchRunResult<T>>
```

Delegates to `workspace.runInBranch()`.

### `promoteBranch(branchCheckpointId, options?)`

```ts
promoteBranch(
  branchCheckpointId: CheckpointId,
  options?: HyperionPromoteBranchOptions
): Promise<HyperionBranchPromotionResult>
```

Delegates to `workspace.promoteBranch()`.

### `dropBranch(branchCheckpointId)`

```ts
dropBranch(branchCheckpointId: CheckpointId): Promise<void>
```

Delegates to `workspace.dropBranch()`.

### `getCheckpointLineage(checkpointId)`

```ts
getCheckpointLineage(checkpointId: CheckpointId): HyperionCheckpointSummary[]
```

Delegates to `workspace.getCheckpointLineage()`.

### `listCheckpointChildren(parentId, options?)`

```ts
listCheckpointChildren(
  parentId: CheckpointId,
  options?: { includeInactive?: boolean }
): HyperionCheckpointSummary[]
```

Delegates to `workspace.listCheckpointChildren()`.

### `listBranchHeads(filter?)`

```ts
listBranchHeads(filter?: HyperionCheckpointHeadFilter): HyperionCheckpointSummary[]
```

Delegates to `workspace.listBranchHeads()`.

### `listSubagentHeads(filter?)`

```ts
listSubagentHeads(filter?: HyperionCheckpointHeadFilter): HyperionCheckpointSummary[]
```

Delegates to `workspace.listSubagentHeads()`.

### `reconcile(checkpointId?)`

```ts
reconcile(checkpointId?: CheckpointId): Promise<ReconcileResult>
```

Delegates to `workspace.reconcile()` and records the result in
`lastReconcileResult`.

### `rollback(checkpointId)`

```ts
rollback(checkpointId: CheckpointId): Promise<void>
```

Delegates to `workspace.rollback()` and records timing in
`lastRollbackMs`.

### `promote(checkpointId, options?)`

```ts
promote(
  checkpointId: CheckpointId,
  options?: HyperionPromoteOptions
): Promise<HyperionPromotionResult>
```

Delegates to `workspace.promote()`.

### `declareToolOutputs(contract)`

```ts
declareToolOutputs(contract: HyperionToolOutputContract): void
```

Delegates to `workspace.declareToolOutputs()`.

### `recoverAttempts()`

```ts
recoverAttempts(): Promise<RecoverableAttempt[]>
```

Delegates to `workspace.recoverAttempts()`.

### `exportPatch(checkpointId)`

```ts
exportPatch(checkpointId: CheckpointId): Promise<string>
```

Delegates to `workspace.exportPatch()`.

### `rehydrateAttempt(checkpointId)`

```ts
rehydrateAttempt(checkpointId: CheckpointId): Promise<CheckpointId>
```

Delegates to `workspace.rehydrateAttempt()`.

### `dispose()`

```ts
dispose(): Promise<void>
```

Delegates to `workspace.dispose()`. Idempotent.

### `getDiagnostics()`

```ts
getDiagnostics(): HyperionAgentSessionDiagnostics
```

Returns workspace diagnostics plus session-specific fields:

```ts
interface HyperionAgentSessionDiagnostics extends HyperionDiagnostics {
  lastReconcileResult?: ReconcileResult;
  lastRollbackMs?: number;
}
```

## Session-specific errors

### `HyperionExecError`

```ts
class HyperionExecError extends Error {
  result: HyperionExecResult;
}
```

Thrown by `exec()` when a child process exits with a non-zero code and
`rejectOnNonZero` is `true` (default).

### `HyperionAttemptRollbackError`

```ts
class HyperionAttemptRollbackError extends Error {
  checkpointId: CheckpointId;
  attemptError: unknown;
  rollbackError: unknown;
  reconcileResult?: ReconcileResult;
}
```

Thrown by `runAttempt()` when the callback throws **and** rollback also
fails. Represents a double-fault — both the attempt and the recovery
failed.

### `HyperionBranchConflictError`

Thrown by `promoteBranch()` and `dropBranch()` when overlapping active
sibling branch dirty paths are rejected by merge conflict policy.

## See also

- [HyperionWorkspace API](/api/workspace/) — the low-level API
- [Types & Errors](/api/types/) — complete config and type reference
