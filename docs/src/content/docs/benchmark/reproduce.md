---
title: Reproduce the Benchmark
description:
  How to reproduce the Hyperion Delta benchmark results on your own
  machine.
---

The benchmark script lives in `benchmark.ts` at the repo root. It
synthesizes a test workspace, runs each strategy, and measures rollback
latency with `process.hrtime.bigint()`.

## Prerequisites

- Node.js 20+
- Git (for the legacy runner baseline)
- Linux or WSL2 for tmpfs and rsync rows

Clone the repository:

```sh
git clone https://github.com/ayush585/Hyperion-Delta.git
cd Hyperion-Delta
npm ci
```

## Smoke test

For a fast local regression check:

```sh
npm run benchmark:smoke
```

Smoke mode uses a small fixture and temporary work root. It validates the
benchmark shape and strategy routing — not final performance evidence.

## Full benchmark

For the full audit-scale defaults:

```sh
npm run benchmark
```

The full run preserves the audit-scale defaults in `benchmark.ts`. For
the cleanest filesystem signal, run inside a native Linux filesystem or
the XFS loopback mount used during audit testing. The tmpfs row appears
automatically when `/dev/shm` is available.

## Environment overrides

```sh
HYPERION_FILE_COUNT=1000 HYPERION_ITERATIONS=3 npm run benchmark
```

| Variable | Default | Description |
|---|---|---|
| `HYPERION_FILE_COUNT` | 50000 | Number of files in the synthetic workspace |
| `HYPERION_ITERATIONS` | 10 | Rollback cycles per runner |

## WSL2 notes

When launched from WSL under `/mnt/c`, the script automatically stages
generated benchmark workspaces in native Linux `/tmp` and prints the
selected work root. This keeps the requested Windows project path usable
while avoiding DrvFS metadata emulation from dominating the benchmark.

## Interpreting results

The target outcome is not "copy-on-write always wins." The meaningful
result is:

- Git reset scales with repository-wide filesystem inspection
- Full tree clone/delete scales with repository-wide metadata churn
- Hyperion targeted rollback scales with the dirty set
- tmpfs dirty-set rollback shows the upper bound when rollback data stays
  in RAM

## Strategy rows

| Row | Requires | What it tests |
|---|---|---|
| Legacy Runner | Git | `git reset --hard` + `git clean -fd` baseline |
| Manifest Restore | None | Universal targeted rollback |
| rsync Link-Dest | `rsync` | POSIX copy-on-write optimization |
| tmpfs Dirty-Set | `/dev/shm` | RAM-backed rollback cache |

If a required capability is unavailable, that row is reported as skipped
instead of failing the run. The script prints the selected work root,
fixture size, iteration count, and runner strategy rows before starting.

## See also

- [Benchmark Results](/benchmark/results/) — the final audit data
- [Strategy Tiers](/architecture/strategies/) — how each strategy works