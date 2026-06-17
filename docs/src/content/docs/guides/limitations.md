---
title: Limitations
description:
  Known limitations of Hyperion Delta and the mitigation strategy for
  each one.
---

Hyperion is a dirty-set rollback engine for local agent attempts. It is
not Git, not a virtual machine, not a package manager, and not a
universal filesystem monitor. That boundary is deliberate.

## 1. No permanent history or merging

Hyperion cannot merge branches, push to remotes, resolve line-by-line
conflicts, or replace signed Git history. Git is slower because it solves
those problems. Hyperion is faster because it does not.

### Mitigation

**Git Companion Architecture** — Hyperion bridges to Git through:

- **Durable attempt journals** — checkpoint metadata written before
  `snapshot()` returns, enabling `recoverAttempts()` from a fresh session
- **Patch export** — `exportPatch()` emits Git-compatible unified diffs
- **Promotion** — `promote()` finalizes worktree state and frees rollback
  storage without running Git
- **Rehydration** — `rehydrateAttempt()` recreates checkpoint state from
  durable metadata when recovery is safe

Journals record metadata, strategy, Git HEAD, ignored patterns, and dirty
summaries but **never** file contents. Git remains the authority for
commits, merges, remotes, signatures, and pushes.

## 2. Platform disparity and the Windows tax

The fastest result (`0.063 ms`) depends on Linux `/dev/shm`. macOS and
Linux can use POSIX hard links. Windows can use NTFS hard links after
Hyperion verifies same-device workspace and storage. Semantics are
consistent across platforms, but latency is not identical.

### Mitigation

**Hot Dirty Buffer + Windows-native link discovery:**

- Small-file pre-mutation backups are cached in process memory (bounded
  by per-file, total-byte, and file-count limits)
- Files spill to the physical strategy when limits are exceeded
- Windows volume discovery records NTFS, Dev Drive, and ReFS signals
- NTFS hard-link storage detaches the workspace target after backup so
  later writes cannot corrupt the backup inode
- ReFS block cloning via `FSCTL_DUPLICATE_EXTENTS_TO_FILE` is a future
  native-helper candidate — it is not invoked by the zero-dependency SDK

`getDiagnostics()` exposes which strategy is active plus Hot Dirty Buffer
hit/spill counters and Windows volume signals.

## 3. Ignored files blindspot

Hyperion excludes dependency and build-output directories from broad
scans by default (`node_modules/**`, `.git/**`, `dist/**`, etc.). This
prevents `snapshot()` and `reconcile()` from walking dependency
blackholes, but creates a blindspot: writes into ignored roots are not
tracked.

### Mitigation

**Strict ignore policy:**

- `strictIgnoredWrites: true` throws `HyperionIgnoredPathError` before
  VFS-captured writes mutate ignored roots
- Non-strict mode records internal diagnostics while preserving write
  behavior
- `track()` accepts exact ignored paths for future tool-adapter
  integrations
- `declareToolOutputs()` lets integrations declare exact generated or
  ignored output paths — they bypass strict blocking, are VFS-tracked,
  and are explicitly statted during `reconcile()`
- `getDiagnostics()` exposes recent ignored-write events with `blocked`,
  `ignored`, and `declared` actions

Broadly scanning ignored folders would break the core scaling law — a
dependency tree can contain hundreds of thousands of files.

## 4. Agent lifecycle complexity

Calling `git reset --hard` is one line. Hyperion requires: snapshot
before attempts, reconcile after child-process execution, rollback on
failure, promote on success, dispose on shutdown, and manage locks during
concurrent MCTS search.

### Mitigation

**Autopilot runner — `HyperionAgentSession.runAttempt()`:**

- Creates a checkpoint before the callback
- Reconciles after each `exec()` call inside the callback
- Reconciles on callback success (optional, on by default)
- Rolls back automatically on callback throw
- Records timing and diagnostics
- Exposes low-level `snapshot()`, `reconcile()`, `rollback()`, and
  `dispose()` for advanced integrations

```ts
const session = new HyperionAgentSession(process.cwd());

await session.runAttempt(async ({ exec }) => {
  await exec("npm", ["test"]);
});

await session.dispose();
```

## North Star

```text
Git
  owns permanent history, merge, remotes, signatures, push

Hyperion
  owns fast local attempt isolation, dirty-set rollback,
  crash cleanup, and agent-loop ergonomics

Agent framework
  owns task planning, tool execution, evaluation, promotion
```

Hyperion's job is to make local agent attempts cheap, isolated,
observable, and reversible — not to replace Git.