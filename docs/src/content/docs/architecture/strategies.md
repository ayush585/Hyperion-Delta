---
title: Strategy Tiers
description:
  How Hyperion selects the fastest safe rollback strategy for your
  platform — tmpfs, POSIX links, NTFS links, Hot Dirty Buffer, or pure
  manifest.
---

Hyperion automatically selects the best storage strategy for your
platform. Every tier provides identical rollback correctness — the only
difference is performance.

## Strategy overview

| Tier | Strategy | Platform | Mechanism |
|---|---|---|---|
| 1 | tmpfs Dirty-Set | Linux / WSL2 | RAM-backed backup in `/dev/shm` |
| 2 | POSIX Hard Link | macOS / Linux | Inode sharing on same device |
| — | NTFS Hard Link | Windows (NTFS) | Hard link + target materialization |
| — | Hot Dirty Buffer | All platforms | In-memory small-file cache |
| 3 | Pure Manifest | All platforms | Copy-based universal baseline |

## Tier selection logic

Hyperion runs environment discovery on workspace construction. It probes
for available capabilities and selects the first viable strategy from
highest to lowest tier:

1. If Linux or WSL2 with writable `/dev/shm` → **tmpfs** (Tier 1)
2. If macOS or Linux with same-device workspace and session root →
   **POSIX hard link** (Tier 2)
3. If Windows with verified NTFS hard-link capability →
   **NTFS link**
4. Otherwise → **Pure Manifest** (Tier 3)

The selected strategy is available via `getDiagnostics().strategy`.

## tmpfs Dirty-Set (Tier 1)

The fastest tier. Dirty file backups are stored in `/dev/shm/hyperion-delta/<session-id>/<checkpoint-id>/`.

- Only dirty files are stored — never the full workspace
- Restore reads directly from RAM
- Cleanup removes the tmpfs namespace on checkpoint dispose
- Startup GC removes stale tmpfs session directories

If `/dev/shm` is missing, out of space, or unwritable, Hyperion degrades
to the next available tier.

## POSIX Hard Link (Tier 2)

Available on macOS and Linux when the workspace and checkpoint session
root are on the same physical device.

Hyperion creates hard links to backup dirty files. Since links share the
same inode, no data copying occurs. The SDK then materializes the
workspace target file so later writes cannot mutate the backup inode.

Cross-device workspace and session root automatically skip this tier to
prevent `EXDEV` errors.

## NTFS Hard Link

Windows-specific acceleration for verified NTFS volumes. Hyperion probes
hard-link capability using `fsutil` during workspace creation, then:

- Creates a hard-link backup inside the checkpoint namespace
- Immediately materializes the workspace file so later writes are safe
- Falls back to Pure Manifest if hard links are unavailable

Dev Drive and ReFS volumes are reported in diagnostics as environment
optimizations. ReFS block cloning via `FSCTL_DUPLICATE_EXTENTS_TO_FILE`
is a future native-helper candidate — it is not invoked by the
zero-dependency SDK.

## Hot Dirty Buffer

A bounded in-memory cache that sits on top of any physical strategy.
Small dirty-file backups are stored in process memory before they spill
to disk.

```ts
const workspace = new HyperionWorkspace({
  workspaceRoot: process.cwd(),
  useHotBuffer: true,           // default: true
  hotBufferMaxFileBytes: 262144, // 256 KiB per file
  hotBufferMaxTotalBytes: 8388608, // 8 MiB total
  hotBufferMaxFiles: 1024,
});
```

Memory use is bounded by three limits. When any limit is exceeded, files
spill to the underlying physical strategy.

## Pure Manifest (Tier 3)

The universal correctness baseline. Works on every platform without any
filesystem-specific capabilities.

Dirty file content is copied into the checkpoint namespace during
snapshot. Restore copies the saved content back. No links, no tmpfs,
no special requirements — just `fs.copyFile` and atomic rename.

This strategy proves the rollback semantics are correct. Performance
strategies are optimizations on top of this proven baseline.

## Platform diagnostics

Call `getDiagnostics()` to inspect the active strategy, storage tier,
Hot Dirty Buffer hit/spill counters, and Windows volume signals:

```ts
const diag = session.getDiagnostics();
console.log(diag.strategy);           // "tmpfs" | "posix-link" | "ntfs-link" | "pure-manifest"
console.log(diag.windowsVolume?.fileSystemName); // "NTFS" | "ReFS" | undefined
console.log(diag.checkpoints[0]?.storage?.hotBuffer?.hits);
```

## Next steps

- [Safety Model](/architecture/safety/) — how rollback guarantees
  correctness at every tier
- [Git Companion](/architecture/git-companion/) — journals, patches,
  and promotion