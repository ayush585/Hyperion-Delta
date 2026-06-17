---
title: Windows Performance
description:
  Hyperion Delta benchmark results on Windows NTFS — without Git, without
  tmpfs, without Linux.
---

Windows NTFS is the most common development environment. These benchmarks
measure Hyperion's manifest restore performance on Windows without any
Git dependency — just `cpSync` and atomic rename.

## 10,000 file repo

A synthetic 10,000-file TypeScript workspace. Hyperion restores 10 dirty
files per rollback cycle averaged over 3 iterations.

| Metric | Value |
|---|---|
| Repo size | 10,000 files |
| Dirty files | 10 |
| Iterations | 3 |
| Synthesis time (one-time) | 31,796 ms |
| **Avg rollback latency** | **62.034 ms** |
| Samples | 70.658, 74.560, 40.883 ms |

## Comparison to Git

On the same machine with the same 10K-file fixture:

| Strategy | Platform | Avg Latency | Speedup |
|---|---|---|---|
| Git `reset --hard` + `clean -fd` | Windows NTFS | ~570 ms | 1.00× |
| Hyperion manifest restore | Windows NTFS | **62.034 ms** | **9.19×** |

Git inspects the entire working tree and re-checks out every tracked
file. Hyperion only copies the 10 files in the dirty set back from the
read-only base.

## Methodology

The benchmark script is at `scripts/win-bench.mjs`. It:

1. Synthesizes a base monorepo of N TypeScript files
2. For each iteration: copies the base into a working directory
3. Mutates `DIRTY_COUNT` tracked files with random content
4. Creates `DIRTY_COUNT` scratch files
5. Measures the time to restore all dirty files from the base and delete
   scratch files
6. Cleans up

No Git, no shell commands, no tmpfs — pure Node.js filesystem operations
on NTFS. All timings use `process.hrtime.bigint()`.

## Running locally

```sh
$env:HYPERION_FILE_COUNT="10000"
$env:HYPERION_DIRTY_COUNT="10"
$env:HYPERION_ITERATIONS="5"
node scripts/win-bench.mjs
```

## See also

- [Benchmark Results](/benchmark/results/) — all sweep data including
  dirty-set scaling, repo-size independence, and agent search
- [Reproduce the Benchmark](/benchmark/reproduce/) — run the full
  benchmark suite