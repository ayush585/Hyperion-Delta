---
title: Git Companion
description:
  Hyperion owns local attempts. Git owns permanent history. Journals,
  patches, and promotion bridge the two.
---

Hyperion is not a mini Git. It does not maintain permanent history,
merge branches, push remotes, or cryptographically sign commits. Git
solves those problems. Hyperion solves a different one: making failed
local agent attempts cheap to undo.

## The three-layer model

```text
Git
  owns permanent history, merge, remotes, signatures, push

Hyperion
  owns fast local attempt isolation, dirty-set rollback,
  crash cleanup, and agent-loop ergonomics

Agent framework
  owns task planning, tool execution, evaluation, promotion
```

Each layer owns one concern. Hyperion does not reach into Git's layer to
commit, merge, or push. Git does not need to understand Hyperion's
checkpoint lifecycle.

## Durable attempt journals

Every checkpoint writes metadata to
`.hyperion/checkpoints/<checkpointId>/journal.json` before the
checkpoint ID is returned.

```json
{
  "checkpointId": "ckpt_abc123",
  "createdAt": "2026-06-17T12:00:00.000Z",
  "strategy": "pure-manifest",
  "gitHead": "a1b2c3d",
  "ignoredPatterns": ["node_modules/**", ".git/**", ".hyperion/**"],
  "baseline": { "files": 51234, "gitTracked": 50410 },
  "dirty": { "created": 3, "modified": 2, "deleted": 0 }
}
```

Journals record checkpoint metadata, strategy, Git HEAD, ignored
patterns, baseline statistics, and dirty-entry summaries. They
intentionally do **not** store file contents — Git owns permanent
history.

Journals enable `recoverAttempts()` to inspect abandoned checkpoints
from a fresh workspace session.

## Patch export

`exportPatch()` emits a Git-compatible unified diff for an active
checkpoint's dirty set. It reconciles first, then produces a text-only
patch for created, modified, and deleted regular files.

```ts
const patch = await workspace.exportPatch(checkpointId);
// --- a/src/index.ts
// +++ b/src/index.ts
// @@ -1,3 +1,3 @@
// ...
```

Patch export does not run Git, commit, merge, push, or dispose the
checkpoint. It is a read-only diagnostic that lets agent frameworks
inspect what an attempt changed without touching the repository.

Binary files, symlinks, and files without backup content cause patch
export to throw loudly rather than produce partial output.

## Promotion

`promote()` accepts the current worktree state in place, marks the
checkpoint as promoted, and frees Hyperion-owned rollback storage.

```ts
await workspace.promote(checkpointId);
```

Promotion also supports returning a patch before cleanup:

```ts
const patch = await workspace.promote(checkpointId, { exportPatch: true });
```

If `{ exportPatch: true }` fails (binary file, missing backup), the
checkpoint remains active and rollback-capable — the promotion is not
applied.

Promoted checkpoints become audit records. They cannot be rolled back,
patched again, or rehydrated. Git remains the authority for staging,
commits, merges, remotes, signatures, and pushes.

## Recovery rehydration

When Hyperion can prove a checkpoint is still restorable, you can
re-create active checkpoint state from durable metadata.

```ts
const summary = await workspace.recoverAttempts();
// [{ checkpointId: "ckpt_abc", canRehydrate: true, reason: null }, ...]

if (summary[0].canRehydrate) {
  const checkpointId = await workspace.rehydrateAttempt(summary[0].checkpointId);
  await workspace.rollback(checkpointId);
}
```

Rehydration works when:
- The journal and backup manifest are intact
- Backup files exist on disk (modified/deleted files need content)
- The workspace matches the journal's recorded workspace path

Volatile Hot Dirty Buffer memory-only backups intentionally block
rehydration after a process restart. If you need recoverability after
crashes, consider disabling the Hot Dirty Buffer or persisting it.

## Next steps

- [Architecture Thesis](/architecture/thesis/) — the performance
  argument for keeping Git and Hyperion separate
- [Quickstart](/guides/getting-started/) — install and run your
  first agent attempt with promotion