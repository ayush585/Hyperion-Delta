# Hyperion Delta-Bench

Hyperion Delta-Bench is a zero-dependency TypeScript timing harness for local agent state rollback. It compares the legacy agent behavior of resetting an entire Git workspace with optimized rollback strategies that only touch files the agent actually changed.

The benchmark synthesizes a 50,000-file TypeScript workspace nested 10 directories deep, then measures 50 rollback cycles with `process.hrtime.bigint()`.

## SDK Quickstart

The production SDK surface is exposed as `@prettiflow/hyperion-delta`. Prettiflow-style agent loops can use the adapter wrapper with only the checkpoint lifecycle in their execution path:

```ts
import { HyperionAgentSession } from "@prettiflow/hyperion-delta";

const session = new HyperionAgentSession(process.cwd());
const checkpointId = await session.snapshot();
try {
  await runAgentAttempt();
  await session.reconcile(checkpointId);
} catch {
  await session.rollback(checkpointId);
} finally {
  await session.dispose();
}
```

`HyperionAgentSession` is a thin wrapper over `HyperionWorkspace`. It installs Node fs interception by default, exposes the selected strategy, stores the last reconcile result, and records rollback timing in milliseconds. Child-process and native-tool writes are still protected by the mandatory reconcile call inside `rollback()`.

Successful attempt checkpoint release is intentionally not a separate public API yet. For this phase, adapter users keep the workspace session alive across attempts and call `dispose()` during CLI shutdown; a dedicated commit/release method is deferred until the core checkpoint lifecycle grows that contract.

## API Reference

The package exports two runtime entry points:

- `HyperionWorkspace`: the core checkpoint, reconcile, rollback, VFS interception, and cleanup API.
- `HyperionAgentSession`: a Prettiflow-oriented wrapper that installs interception by default and records diagnostics.

Core methods:

- `track(path | paths)`: manually register paths for future integrations that cannot use interception.
- `snapshot()`: capture a checkpoint and return a `CheckpointId`.
- `reconcile(checkpointId?)`: refresh dirty-set state after child-process or native-tool writes.
- `rollback(checkpointId)`: reconcile, restore dirty paths, delete created paths, and clean ghost directories.
- `dispose()`: unregister hooks/interceptors and clean Hyperion-owned session state.

Public types and errors are exported from the package root, including `HyperionConfig`, `ReconcileResult`, `StorageStrategyKind`, `HyperionError`, `HyperionCapacityError`, `HyperionIntegrityError`, `HyperionPathError`, and `HyperionRollbackError`.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design, failure model, and strategy router details.

## Release Checks

For local package readiness:

```sh
npm run release:check
```

This runs typecheck, tests, build, `npm pack --dry-run`, and a temp-project install smoke. The install smoke packs the SDK into an OS temp directory, installs it into a temporary sample project, and imports both `HyperionWorkspace` and `HyperionAgentSession` from the installed package.

For a focused install smoke after an existing build:

```sh
npm run package:smoke
```

The published package is intentionally limited to `dist`, `README.md`, `ARCHITECTURE.md`, and required npm metadata. Benchmark commands are repository-checkout utilities and are not part of the SDK runtime surface.

## Troubleshooting

- Git unavailable: Hyperion falls back to stat-only manifests. Correctness remains, but large non-Git workspaces may start slower.
- tmpfs unavailable: Linux `/dev/shm` acceleration is skipped and the SDK degrades to POSIX links or pure manifest restore.
- `rsync` unavailable: POSIX-link-style benchmark rows may be skipped, and SDK behavior remains on the safest available strategy.
- Windows or NTFS: the SDK uses the pure manifest baseline for correctness rather than POSIX-only link assumptions.
- Ignored paths: `node_modules/**`, `.git/**`, and `.hyperion/**` are ignored by default so dependency and internal state folders are not tracked.
- Child-process modified/deleted files: `reconcile()` detects them, and `rollback()` always reconciles first. Restoring modified or deleted files still requires a pre-mutation backup from VFS interception or a future explicit tracking integration.
- Missing backup record: rollback fails loudly with an integrity error instead of silently corrupting or partially restoring the workspace.

## What It Measures

The current benchmark compares:

- `Legacy Runner`: mutates a tracked file, creates an untracked scratch file, then runs `git reset --hard HEAD` and `git clean -fd`.
- `Targeted Reversion`: tracks the modified files in a manifest, restores only those files from a read-only base, and deletes only manifest-listed scratch files.
- `rsync Targeted Reversion`: creates a linked working tree with `rsync --link-dest`, then restores only changed files with an rsync file list.
- `tmpfs Targeted Reversion`: keeps the dirty-set rollback cache in `/dev/shm` on Linux/WSL2 so the files the agent actually touched restore from RAM.

## Lessons from the Metadata Bottleneck

Initial testing revealed that standard directory cloning strategies trigger inode metadata thrashing on 50k+ file systems, outperforming Git only on block-level I/O but failing on metadata throughput.

The first implementation used Linux reflinks with `cp -a --reflink=always`, then deleted and recloned the whole 50,000-file sandbox every turn. On the WSL2 XFS loopback test drive, it produced this result:

```text
Legacy Runner total:   190,694.525 ms
Legacy average:         3,813.890 ms

Hyperion full clone total: 816,614.450 ms
Hyperion full clone avg:    16,332.289 ms
```

That failure is useful. Reflinks avoid copying file blocks, but they do not eliminate directory traversal, inode allocation, unlink work, or metadata updates. A real local agent should not throw away an entire tree when it knows which files it touched.

Hyperion's practical optimization is therefore targeted state reversion: track the agent's dirty set and revert only those paths. The tmpfs mode demonstrates the upper bound for Prettiflow-style local search when dirty-set content and metadata operations live in RAM.

## Running The Benchmark

For a fast local regression check:

```sh
npm run benchmark:smoke
```

Smoke mode uses a small fixture and temporary work root. It validates the benchmark shape and strategy routing, not final performance evidence.

For the full benchmark defaults:

```sh
npm run benchmark
```

The full run preserves the audit-scale defaults in `benchmark.ts`. For the cleanest filesystem signal, run inside a native Linux filesystem or the XFS loopback mount used during audit testing. The tmpfs row appears automatically when `/dev/shm` is available.

When launched from WSL under `/mnt/c`, the script automatically stages generated benchmark workspaces in native Linux `/tmp` and prints the selected work root. This keeps the requested Windows project path usable while avoiding DrvFS metadata emulation from dominating the benchmark.

The benchmark prints the selected work root, fixture size, iteration count, and runner strategy rows. If optional capabilities are unavailable, such as `rsync` or Linux `/dev/shm`, those rows are reported as skipped instead of failing the run.

The script also accepts environment overrides while preserving the audit defaults:

```sh
HYPERION_FILE_COUNT=1000 HYPERION_ITERATIONS=3 npm run benchmark
```

## Interpreting Results

The target outcome is not "copy-on-write always wins." The meaningful result is:

- Git reset scales with repository-wide filesystem inspection.
- Full tree clone/delete scales with repository-wide metadata churn.
- Targeted rollback scales with the number of files the agent actually changed.
- tmpfs dirty-set rollback shows the best-case latency when the rollback cache avoids disk hardware entirely.
