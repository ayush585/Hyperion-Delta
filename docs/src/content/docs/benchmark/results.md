---
title: Benchmark Results
description:
  Hyperion Delta benchmark evidence — 55,000x faster rollback than Git,
  scaling with the dirty set instead of the repository.
---

The benchmark synthesizes a 50,000-file TypeScript workspace nested 10
directories deep, then measures rollback cycles with `process.hrtime.bigint()`.

## Final audit results

| Runner | Total Block Time | Avg Rollback Latency | Speedup vs Git | Reduction |
|---|---|---|---|---|
| Git (`reset --hard` + `clean -fd`) | 34,784.070 ms | **3,478.407 ms** | 1.00× | 0.00% |
| Manifest restore (dirty-set only) | 9.715 ms | **0.971 ms** | 3,580.50× | 99.97% |
| `rsync` link-dest restore | 504.942 ms | **50.494 ms** | 68.89× | 98.55% |
| tmpfs dirty-set restore (WSL2) | 0.634 ms | **0.063 ms** | 54,851.92× | 100.00% |

10 rollback iterations per runner, measured in WSL2 on an XFS loopback
test drive for the cleanest filesystem signal.

![Benchmark dashboard full](/benchmark/full.png)

## What the benchmark measures

The benchmark creates a 50,000-file fixture and simulates one agent edit
cycle per iteration:

1. **Legacy Runner** — mutates a tracked file, creates an untracked
   scratch file, then runs `git reset --hard HEAD` followed by
   `git clean -fd`. This is the baseline.

2. **Targeted Manifest Restore** — tracks modified files in a manifest,
   restores only those files from a read-only base, and deletes only
   manifest-listed scratch files.

3. **rsync Targeted Restore** — creates a linked working tree with
   `rsync --link-dest`, then restores only changed files with an rsync
   file list.

4. **tmpfs Dirty-Set Restore** — keeps the dirty-set rollback cache in
   `/dev/shm` on Linux/WSL2 so the files the agent actually touched
   restore from RAM.

## The metadata bottleneck

The first implementation used Linux reflinks with `cp -a --reflink=always`
and then deleted and recloned the whole 50,000-file sandbox every turn.

```text
Legacy Git reset average:     3,813.890 ms
Full clone/delete average:   16,332.289 ms  (4.3× slower than Git)
```

Reflinks avoid copying file blocks, but they do not eliminate directory
traversal, inode allocation, unlink work, or metadata updates. A real
local agent should not throw away an entire tree when it knows which
files it touched.

Hyperion's practical optimization is **targeted state reversion**: track
the agent's dirty set and revert only those paths. tmpfs demonstrates the
upper bound when dirty-set content and metadata operations live in RAM.

## Raw evidence

- [`benchmark-final-run.log`](https://github.com/ayush585/Hyperion-Delta/blob/main/benchmark-final-run.log)
- [`benchmark-final-table.png`](https://github.com/ayush585/Hyperion-Delta/blob/main/benchmark-final-table.png)
- [`benchmark-final-full.png`](https://github.com/ayush585/Hyperion-Delta/blob/main/benchmark-final-full.png)

## Next steps

- [Reproduce the benchmark](/benchmark/reproduce/) — run it yourself
- [Architecture Thesis](/architecture/thesis/) — the scaling argument