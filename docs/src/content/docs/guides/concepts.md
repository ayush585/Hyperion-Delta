---
title: Core Concepts
description:
  Understand checkpoints, reconcile, rollback, promote, dispose, and VFS
  interception — the building blocks of Hyperion Delta.
---

Every agent attempt in Hyperion follows the same lifecycle: snapshot
before, reconcile after, rollback on failure, promote on success, dispose
when done. These pages explain what each step does and why it exists.

## Checkpoint

A checkpoint is a snapshot of your workspace at a point in time. It
records every tracked file's metadata — path, type, size, modification
time, and mode — without hashing file contents.

```ts
const checkpointId = await workspace.snapshot();
```

Checkpoints ignore dependency and internal folders by default
(`node_modules/**`, `.git/**`, `.hyperion/**`, `dist/**`, etc.).
This keeps snapshot creation fast and prevents walking massive dependency
trees.

Each checkpoint gets a unique ID. Multiple checkpoints can be active at
the same time with isolated dirty sets — useful for MCTS-style branching
where one agent path explores a different set of mutations.

## Reconcile

Reconcile catches filesystem changes that happened **outside** the VFS
interceptor — child processes, native binaries, shell redirections.

```ts
const result = await workspace.reconcile(checkpointId);
// result.created  — paths added since the checkpoint
// result.modified — paths changed since the checkpoint
// result.deleted  — paths removed since the checkpoint
```

Reconcile re-runs the state engine, compares against the checkpoint
baseline, and merges any new dirty entries. It is **mandatory** before
rollback — the `rollback()` method calls `reconcile()` automatically, and
this cannot be disabled.

Child-process coverage includes `npm install`, `tsc`, formatters,
`esbuild`, `oxc`, SWC, Python extensions, and native npm hooks.

## Rollback

Rollback restores the workspace to its state at checkpoint time. It only
touches files in the dirty set — not your entire repository.

```ts
await workspace.rollback(checkpointId);
```

The rollback order is:
1. Call `reconcile()` to catch any missed mutations
2. Restore modified files from backup records
3. Recreate deleted files from backup records
4. Delete files created after the checkpoint
5. Clean ghost directories (empty parents created by the agent)
6. Mark the checkpoint as disposed

Restoration uses same-directory temporary files with atomic rename —
a partial crash during rollback will not leave behind corrupted targets.

If a backup record is missing for a modified or deleted file, rollback
throws an integrity error rather than silently continuing.

## Promote

Promote finalizes a successful attempt. It accepts the current worktree
state in place and frees Hyperion-owned rollback storage.

```ts
await workspace.promote(checkpointId);
```

Promotion does **not** run Git. It does not stage, commit, merge, or push.
Git remains the authority for permanent history. Promotion simply tells
Hyperion "this attempt is done, clean up the rollback resources."

Promoted checkpoints become audit records. They cannot be rolled back,
exported as patches, or rehydrated.

## Dispose

Dispose tears down a workspace session. It uninstalls the VFS
interceptor, removes the current session directory, cleans active
checkpoint storage namespaces, and unregisters lifecycle hooks.

```ts
await workspace.dispose();
```

Dispose is idempotent — calling it multiple times is safe. After dispose,
calling `snapshot()`, `rollback()`, or `promote()` will throw.

## VFS Interception

Hyperion patches Node's `fs` module to track writes automatically. No
decorators, no manual `track()` calls needed for normal agent operations.

**Patched APIs:**
- Sync: `writeFileSync`, `appendFileSync`, `renameSync`, `unlinkSync`,
  `rmSync`, `mkdirSync`, `copyFileSync`, `chmodSync`, `utimesSync`
- Callback: `writeFile`, `appendFile`, `write`, `writev`, `truncate`,
  `symlink`, `link`, `fchmod`, `futimes`, `rename`, `unlink`, `rm`,
  `mkdir`, `copyFile`, `chmod`, `utimes`
- Promise: `fs/promises.writeFile`, `appendFile`, `truncate`, `symlink`,
  `link`, `rename`, `unlink`, `rm`, `mkdir`, `copyFile`, `chmod`,
  `utimes`
- Streams: `createWriteStream`

**Blindspots (why reconcile exists):**
- Child-process writes (`esbuild`, `tsc`, `npm install`)
- Native binaries
- Shell redirections
- Memory-mapped files

The VFS interceptor catches everything a Node-based agent does directly.
Reconcile catches everything else. Together they provide complete
coverage of the agent's filesystem footprint.

## Next steps

- [Quickstart](/guides/getting-started/) — install and run your first
  agent attempt
- [API Reference](/api/workspace/) — full method signatures and type
  contracts
- [Safety Model](/architecture/safety/) — atomic restore, integrity
  guarantees, and the reconcile firewall
