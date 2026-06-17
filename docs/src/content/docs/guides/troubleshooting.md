---
title: Troubleshooting
description:
  Common issues when using Hyperion Delta and how to resolve them.
---

## Git unavailable

Hyperion falls back to stat-only manifests. Correctness remains, but
large non-Git workspaces may start slower.

**What to do:** Install Git or accept the stat-only fallback. The SDK
detects Git availability during workspace construction.

## tmpfs unavailable

Linux `/dev/shm` acceleration is skipped and the SDK degrades to POSIX
links or pure manifest restore.

**What to do:** Nothing required — rollback correctness is preserved. The
tmpfs tier is an optimization, not a requirement. Mount `/dev/shm` if you
want the fastest path on Linux/WSL2.

## `rsync` unavailable

POSIX-link-style benchmark rows are skipped, and SDK behavior remains on
the safest available strategy.

**What to do:** Install `rsync` if you need the POSIX link optimization
on macOS or Linux.

## Windows or NTFS

Verified NTFS volumes can use `ntfs-link` dirty-set backup acceleration.
Dev Drive and ReFS signals appear in diagnostics. ReFS block clone is
intentionally deferred until a native Windows API helper exists.

**What to do:** Small VFS-backed edits are still accelerated by the Hot
Dirty Buffer before spilling to disk. Run `getDiagnostics()` to check
`windowsVolume.fileSystemName` and `windowsVolume.hardLinkCapable`.

## Ignored paths

`node_modules/**`, `.git/**`, and `.hyperion/**` are ignored by default
so dependency and internal state folders are not tracked.

**What to do:** If you need to track files inside an ignored root, use
`track()` with the exact path or `declareToolOutputs()` for tool-specific
outputs.

## Strict ignored writes

Set `strictIgnoredWrites: true` to throw `HyperionIgnoredPathError`
before in-process VFS writes mutate ignored roots.

**What to do:** Either disable strict mode or use `declareToolOutputs()`
to register exact paths that should be allowed through.

## Tool output contracts

Call `declareToolOutputs()` before running package managers, build
systems, formatters, or codegen tools that write exact ignored/generated
files.

```ts
workspace.declareToolOutputs({
  toolName: "vite",
  checkpointId,
  outputs: ["node_modules/.cache/vite/deps_metadata.json"],
});
```

Undeclared ignored writes still follow the `strictIgnoredWrites` policy.

## Diagnostics

Call `getDiagnostics()` to inspect selected strategy, actual storage
tier, Hot Dirty Buffer hit/spill counters, Windows volume signals, active
checkpoint storage, and recent ignored-write events.

```ts
const diag = session.getDiagnostics();
console.log(diag.strategy);
console.log(diag.windowsVolume?.fileSystemName);
```

Diagnostics are snapshots. Mutating the returned object does not mutate
SDK state, and calling diagnostics does not run Git, shell commands, or
filesystem scans.

## Durable journal recovery

Call `recoverAttempts()` from a new workspace or session to inspect
abandoned checkpoint metadata and `canRehydrate` status.

```ts
const attempts = await workspace.recoverAttempts();
for (const a of attempts) {
  console.log(a.checkpointId, a.canRehydrate, a.nonRehydratableReason);
}
```

Returns an empty array if `durableAttemptJournals` is disabled.

## Rehydration failures

`rehydrateAttempt()` rejects disposed attempts, corrupt journals, missing
backup manifests, missing backup files, cross-workspace journals, and
volatile memory-only backups.

**What to do:** Check the error message. Volatile Hot Dirty Buffer
backups are intentionally non-rehydratable — they exist only in process
memory. Disable the Hot Dirty Buffer if recovery after restart is
required.

## Patch export

`exportPatch()` supports text regular files and requires backup records
for modified or deleted paths. Binary, symlink, and backup-missing
exports fail loudly with integrity errors.

**What to do:** Ensure the checkpoint has VFS backup records for all
modified or deleted paths. Child-process modifications without VFS
pre-mutation backups cannot be patched.

## Promotion

`promote()` finalizes the current worktree state and does not run Git. If
`{ exportPatch: true }` fails because a dirty file is binary, a symlink,
or missing backup content, the checkpoint remains active and
rollback-capable.

**What to do:** Run `git add` and `git commit` yourself after
`promote()`. Hyperion handles rollback storage cleanup only.

## Child-process modified or deleted files

`reconcile()` detects them, and `rollback()` always reconciles first.
Restoring modified or deleted files still requires a pre-mutation backup
from VFS interception or a future explicit tracking integration.

**What to do:** Install the VFS interceptor before any agent code runs
(it is installed by default in `HyperionAgentSession`). Files modified
by `npm install`, `tsc`, or `esbuild` are detected by reconcile but can
only be restored if a backup record exists.

## Missing backup record

Rollback fails loudly with an integrity error instead of silently
corrupting or partially restoring the workspace.

**What to do:** The checkpoint cannot be safely rolled back. Create a new
checkpoint from the current state or manually restore the affected files.
This typically happens when a child process or native tool modified a
file that was never backed up by the VFS interceptor.