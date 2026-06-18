---
title: Reliability
description:
  Reliability goals, stress strategy, and CI thresholds for Hyperion Delta.
---

## Reliability SLOs

Hyperion Delta treats rollback correctness as a hard safety boundary. The
release target is:

- **Silent corruption:** `0`
- **Rollback invariant violations:** `0`
- **Reliability suite flake rate:** `< 0.1%`
- **Cross-platform CI matrix:** required (`linux`, `windows`, `macos`)

## PR reliability gates

Pull requests run the reliability workflow:

- **Unit matrix** across Linux, Windows, and macOS
- **Failure injection** checks for snapshot/reconcile/rollback error paths
- **Fuzz smoke** with deterministic seeded mutation batches
- **Stress smoke** with concurrent snapshot/reconcile/rollback loops
- **Branch contention stress** with parallel subagent promote/drop conflict pressure

## Nightly soak

Nightly soak extends the same seeded fuzz and stress suites with larger
thresholds and longer runtime budgets.

The soak jobs run on all supported operating systems and fail on any
invariant break, including:

- checkpoint lock/status violations
- active-checkpoint leaks after stress loops
- rollback mismatch against baseline workspace snapshots

## Local reliability commands

```sh
npm run test:reliability:fuzz
npm run test:reliability:stress
npm run test:reliability:ci
npm run test:reliability:repeatability
```

For long soak runs:

```sh
npm run test:reliability:nightly
```

You can tune thresholds with environment variables such as
`HYPERION_FUZZ_SEEDS`, `HYPERION_FUZZ_OPS`, `HYPERION_STRESS_CYCLES`,
`HYPERION_STRESS_CONCURRENCY`, `HYPERION_BRANCH_STRESS_CYCLES`, and
`HYPERION_BRANCH_SUBAGENTS`.
