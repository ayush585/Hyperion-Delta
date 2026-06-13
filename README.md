# Hyperion Delta-Bench

Hyperion Delta-Bench is a zero-dependency TypeScript timing harness for local agent state rollback. It compares the legacy agent behavior of resetting an entire Git workspace with optimized rollback strategies that only touch files the agent actually changed.

The benchmark synthesizes a 50,000-file TypeScript workspace nested 10 directories deep, then measures 50 rollback cycles with `process.hrtime.bigint()`.

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

## Running

On Linux or WSL2:

```bash
npx --yes tsx benchmark.ts
```

For the cleanest filesystem signal, run inside a native Linux filesystem or the XFS loopback mount used during audit testing. The tmpfs row appears automatically when `/dev/shm` is available.

When launched from WSL under `/mnt/c`, the script automatically stages generated benchmark workspaces in native Linux `/tmp` and prints the selected work root. This keeps the requested Windows project path usable while avoiding DrvFS metadata emulation from dominating the benchmark.

For quick smoke checks, the script also accepts environment overrides while preserving the audit defaults:

```bash
HYPERION_FILE_COUNT=1000 HYPERION_ITERATIONS=3 npx --yes tsx benchmark.ts
```

## Interpreting Results

The target outcome is not "copy-on-write always wins." The meaningful result is:

- Git reset scales with repository-wide filesystem inspection.
- Full tree clone/delete scales with repository-wide metadata churn.
- Targeted rollback scales with the number of files the agent actually changed.
- tmpfs dirty-set rollback shows the best-case latency when the rollback cache avoids disk hardware entirely.
