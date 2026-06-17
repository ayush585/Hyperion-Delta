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

## Sweep: Dirty-set scaling

Proves that rollback scales with the number of files changed, not the
size of the repository. **1,000-file repo, 20-15 iterations, Windows NTFS.**

| Dirty Files | Git Reset | Manifest Restore | Speedup |
|---|---:|---:|---:|
| 1 | 663.229 ms | **4.325 ms** | 153.35× |
| 5 | 586.910 ms | **7.830 ms** | 74.96× |
| 10 | 657.239 ms | **19.992 ms** | 32.87× |
| 50 | 784.373 ms | **171.880 ms** | 4.56× |
| 100 | 854.158 ms | **298.908 ms** | 2.86× |

Git reset time stays flat at ~600-850ms regardless of dirty count — it
always inspects the entire working tree. Hyperion scales linearly: each
additional dirty file adds roughly ~3ms.

## Sweep: Repo-size independence

Proves that Hyperion's rollback time does **not** grow with repository
size. **10 dirty files, Windows NTFS.**

| Repo Files | Git Reset | Manifest Restore | Speedup |
|---:|---:|---:|---:|
| 1,000 | 579.231 ms | **21.326 ms** | 27.16× |
| 5,000 | 1,887.470 ms | **13.410 ms** | 140.75× |

Git reset balloons 3.3× when the repo grows from 1K to 5K files.
Hyperion's manifest restore stays flat at ~13-21ms — it only touches the
10 files in the dirty set regardless of repo size.

## Sweep: Agent-search stress

Simulates MCTS-style branching where an agent explores multiple code
paths simultaneously. **500-file repo, Windows NTFS.**

| Branches | Files/Branch | Avg Cycle |
|---:|---:|---:|
| 5 | 3 | **67.757 ms** |
| 8 | 5 | **45.422 ms** |
| 10 | 10 | **147.297 ms** |

Each cycle mutates files across all branches in sequence. An agent
testing 10 alternative paths with 10 edits each completes in under
150ms — fast enough for real-time search loops.

## Windows-native: No Git required

Hyperion manifest rollback on Windows without any Git dependency.
**10,000-file repo, 10 dirty files, 3 iterations.**

| Metric | Value |
|---|---|
| Synthesis (one-time) | 31,796 ms |
| Avg rollback latency | **62.034 ms** |

Compare to Git reset on the same machine at 10K files: ~570ms.
Hyperion is **9.2× faster** on Windows alone, with zero Git operations
on the hot path.

## Next steps

- [Reproduce the benchmark](/benchmark/reproduce/) — run it yourself
- [Windows performance](/benchmark/windows/) — detailed Windows-native
  benchmark methodology
- [Architecture Thesis](/architecture/thesis/) — the scaling argument