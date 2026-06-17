---
title: Quickstart
description:
  Install Hyperion Delta and run your first agent attempt with dirty-set
  rollback in under 5 minutes.
sidebar:
  label: Quickstart
  order: 1
---

Hyperion Delta makes local agent attempts cheap to undo. Install it,
create a session, run an attempt, and promote the result — all in a few
lines of code.

## Prerequisites

- **Node.js 20+** — required by the SDK runtime
- A **project directory** — any Git or non-Git workspace

## Install

```sh
npm install hyperion-delta
```

The package has **zero runtime dependencies**.

## 1. Create a session

`HyperionAgentSession` is the recommended entry point. It creates a
workspace, installs Node filesystem interception, and provides a
high-level attempt lifecycle API.

```ts
import { HyperionAgentSession } from "hyperion-delta";

const session = new HyperionAgentSession(process.cwd());
```

The session discovers your platform and selects the fastest safe storage
strategy — tmpfs on Linux, POSIX links on macOS, NTFS links on Windows,
or pure manifest everywhere.

## 2. Run an attempt

`runAttempt()` wraps one agent attempt. It snapshots the workspace
before your callback runs, reconciles after each child-process execution,
and rolls back automatically if your callback throws.

```ts
const result = await session.runAttempt(async ({ exec }) => {
  // Agent mutates files here
  await exec("npm", ["run", "build"]);
});
```

The `exec()` helper runs explicit executables with an argument array — no
shell string execution. After the process exits, it reconciles the active
checkpoint so rollback knows exactly what changed.

## 3. Execute commands safely

Inside `runAttempt()`, the callback receives an `exec()` function. Use it
for child-process calls so Hyperion can catch the resulting filesystem
mutations.

```ts
await session.runAttempt(async ({ exec }) => {
  await exec("npx", ["tsc", "--noEmit"]);
  await exec("npx", ["vitest", "run"]);
});
```

You can also call `exec()` directly on the session for one-off commands
outside an attempt block.

## 4. Promote

When an attempt succeeds, call `promote()` to accept the current worktree
state. Promotion finalizes the checkpoint, frees Hyperion-owned rollback
storage, and leaves `git add`, `git commit`, and `git push` to your
workflow.

```ts
await session.promote(result.checkpointId);
```

Promoted checkpoints become audit records. They cannot be rolled back,
re-exported, or rehydrated.

## 5. Dispose

Always dispose the session at the end. This uninstalls the VFS
interceptor, cleans Hyperion-owned session directories, and unregisters
lifecycle hooks.

```ts
await session.dispose();
```

Dispose is idempotent — calling it more than once is safe.

## Full example

```ts
import { HyperionAgentSession } from "hyperion-delta";

const session = new HyperionAgentSession(process.cwd());

try {
  const attempt = await session.runAttempt(async ({ exec }) => {
    // Your agent mutates files here
    await exec("npm", ["test"]);
  });
  await session.promote(attempt.checkpointId);
} finally {
  await session.dispose();
}
```

## Next steps

- [Core Concepts](/guides/concepts/) — understand checkpoints, reconcile,
  rollback, and the VFS interception model
- [API Reference](/api/workspace/) — full method signatures for
  `HyperionWorkspace` and `HyperionAgentSession`
- [Architecture](/architecture/thesis/) — why rollback scales with the
  dirty set, not the repository