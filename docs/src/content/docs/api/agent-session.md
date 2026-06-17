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
}
```

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
`exitCode !== 0`.

### `snapshot()`

```ts
snapshot(): Promise<CheckpointId>
```

Delegates to `workspace.snapshot()`.

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

## See also

- [HyperionWorkspace API](/api/workspace/) — the low-level API
- [Types & Errors](/api/types/) — complete config and type reference