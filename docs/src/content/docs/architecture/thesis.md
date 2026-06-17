---
title: Thesis
description:
  Why Hyperion makes rollback scale with the dirty set — not the entire
  repository.
---

Most local coding agents use Git as their state-recovery primitive. That
makes rollback scale with repository size: Git must inspect the working
tree, clean untracked files, and traverse metadata across large file
systems.

Hyperion changes the scaling law. It makes rollback scale with the dirty
set — the files the agent actually touched.

## The benchmark

In the final audit run, a 50,000-file TypeScript workspace measured
10 rollback cycles with `process.hrtime.bigint()`.

| Runner | Avg Rollback Latency | Speedup vs Git |
|---|---|---|
| Git (`reset --hard` + `clean -fd`) | **3,478.407 ms** | 1.00× |
| Manifest restore (dirty-set only) | **0.971 ms** | 3,580.50× |
| POSIX `rsync` link-dest restore | **50.494 ms** | 68.89× |
| tmpfs dirty-set restore (WSL2) | **0.063 ms** | 54,851.92× |

The gap is not marginal. It is one algorithm scaling linearly with
repository metadata throughput versus another algorithm scaling with
the number of files the agent actually changed.

## The metadata bottleneck

Initial testing revealed that standard directory cloning strategies
trigger inode metadata thrashing on 50k+ file systems. The first
implementation used Linux reflinks with `cp -a --reflink=always`, then
deleted and recloned the whole 50,000-file sandbox every turn.

```text
Legacy Runner total:   190,694.525 ms
Legacy average:         3,813.890 ms

Hyperion full clone total: 816,614.450 ms
Hyperion full clone avg:    16,332.289 ms
```

Reflinks avoid copying file blocks, but they do not eliminate directory
traversal, inode allocation, unlink work, or metadata updates. Full-tree
clone/delete was slower than Git — not because copy-on-write is slow,
but because metadata is the bottleneck.

Hyperion's practical optimization is targeted state reversion: track the
agent's dirty set and revert only those paths.

## Product boundary

Hyperion is a Node.js/TypeScript SDK for local agent execution loops. It
is **not** a Git replacement, a search index, a package manager, or a
virtual machine.

It owns one boundary: fast, safe rollback of local filesystem mutations
made during an agent attempt.

```ts
import { HyperionWorkspace } from "hyperion-delta";
```

The target integration has zero operational knobs for the agent engineer.
Create a workspace, install the interceptor, snapshot before attempts,
and Hyperion handles the rest.

## Lessons from the benchmark

- Git reset scales with repository-wide filesystem inspection
- Full tree clone/delete scales with repository-wide metadata churn
- Hyperion manifest rollback scales with the dirty set
- tmpfs dirty-set rollback shows the upper bound when rollback metadata
  and content stay in RAM

The practical takeaway: for Prettiflow-style local MCTS or repair loops,
an agent can test far more branches without leaving the developer's
workspace dirty — because each failed attempt costs microseconds instead
of seconds.

## Next steps

- [Strategy Tiers](/architecture/strategies/) — how Hyperion selects the
  fastest safe storage for your platform
- [Safety Model](/architecture/safety/) — atomic restore, integrity
  guarantees, and the reconcile firewall