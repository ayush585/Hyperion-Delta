---
title: Safety Model
description:
  How Hyperion guarantees rollback correctness — reconcile firewall,
  atomic restore, integrity checks, and ignored-write protection.
---

Hyperion treats rollback as a safety-critical operation. A failed
rollback must fail loudly before corrupting source files. Every safety
guarantee is built on a specific mechanism.

## Reconcile firewall

The VFS interceptor catches writes from Node.js code. Child-process and
native-tool writes — from `tsc`, `esbuild`, `npm install`, or Python
extensions — bypass the interceptor.

`rollback()` calls `reconcile()` automatically before restoring files.
This behavior cannot be disabled.

```ts
// Explicit reconcile (called automatically by rollback)
const result = await workspace.reconcile(checkpointId);
// result.created  — new files from child processes
// result.modified — changed files from child processes
// result.deleted  — removed files from child processes
```

Reconcile re-runs the hybrid state engine, diffs against the checkpoint
baseline, and merges any newly discovered dirty entries. This guarantees
that no filesystem mutation escapes detection before rollback.

## Atomic restore

Modified and deleted files are restored through a two-step process:

1. **Write to a temporary file** in the same directory as the target
2. **Atomic rename** over the target path

If the process crashes between step 1 and step 2, the temporary file is
left behind. The target file is never partially written. Startup GC
removes abandoned temp files on the next workspace construction.

For deleted files, parent directories are recreated before the temp-file
write. For created files, only manifest-listed paths are deleted — no
recursive cleanup outside the dirty set.

## Ghost directory cleanup

After deleting created files during rollback, Hyperion reverse-walks
parent directories and removes empty ones that the agent created. It
stops at:

- The workspace root
- Pre-existing baseline directories
- Ignored boundaries
- The first non-empty directory

This prevents leftover empty `src/components/new-feature/` directories
from accumulating across failed attempts.

## Integrity errors

If a backup record is missing for a modified or deleted file, rollback
throws a `HyperionIntegrityError`. It does not silently continue with
partial or corrupt workspace state.

```ts
try {
  await workspace.rollback(checkpointId);
} catch (err) {
  if (err instanceof HyperionIntegrityError) {
    // Backup is missing — workspace integrity cannot be guaranteed
  }
}
```

Missing backup scenarios include:
- A file was modified by a child process with no VFS pre-mutation backup
- Backup storage was corrupted or manually deleted
- A file was created before the interceptor was installed, then deleted
  by a native tool

The checkpoint remains active after an integrity error — the workspace
is not partially rolled back.

## Ignored-write safety

Hyperion excludes dependency and build-output directories from broad
scans by default:

```text
node_modules/**   .git/**   .hyperion/**
dist/**           build/**  coverage/**
.next/**          .turbo/** .cache/**
```

This prevents `snapshot()` and `reconcile()` from walking thousands of
irrelevant files. But it creates a blindspot: writes into ignored roots
are not tracked.

### Strict mode

`strictIgnoredWrites: true` throws a `HyperionIgnoredPathError` before
VFS-captured writes mutate ignored roots. The write is blocked, the file
is not modified, and the error tells you exactly which path was targeted.

```ts
const workspace = new HyperionWorkspace({
  workspaceRoot: process.cwd(),
  strictIgnoredWrites: true,
});
```

### Tool output contracts

For legitimate writes into ignored directories — package manager lock
files, build caches, codegen outputs — use `declareToolOutputs()` to
declare exact paths that are allowed.

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

Declared outputs bypass strict ignored-write blocking, are tracked by
VFS interception, and are explicitly statted during `reconcile()`.
Contracts are exact-path only — they do not enable recursive scans of
dependency or build-output folders.

## Default ignores

The default ignore list targets dependency directories and internal
state folders that should never be part of an agent's mutation dirty
set. The full list excludes `node_modules/**`, `.git/**`, `.hyperion/**`,
`.pnpm-store/**`, `.yarn/cache/**`, `.npm/**`, `dist/**`, `build/**`,
`coverage/**`, `.next/**`, `.turbo/**`, and `.cache/**`.

Custom patterns extend the defaults unless `overrideDefaultIgnores` is
set to `true`.

## Next steps

- [Git Companion](/architecture/git-companion/) — how Hyperion bridges
  fast local attempts to durable Git workflows
- [Thesis](/architecture/thesis/) — the benchmark evidence behind the
  safety model