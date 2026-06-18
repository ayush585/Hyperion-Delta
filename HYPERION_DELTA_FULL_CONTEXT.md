# Hyperion Delta: End-to-End Project Context

This document is a single, shareable brief for Hyperion Delta: what problem it solves, how it works, where it fits, benchmark evidence, API surface, safety model, and real-world use cases.

## 1) Executive Summary

Hyperion Delta is a Node.js/TypeScript SDK for local AI-agent execution loops.

Its core thesis is simple:

- Rollback should scale with the files an agent changed (dirty set), not with the size of the entire repository.

Why this matters:

- AI agents mutate files repeatedly (try -> test -> fail -> rollback -> retry).
- Git-style full-tree reset/clean is robust but expensive for every failed attempt.
- Hyperion provides fast, safe, deterministic local rollback while Git remains the permanent source of truth.

Current package:

- npm: `hyperion-delta@0.1.7`
- Runtime: Node.js 20+
- Runtime dependencies: none

## 2) Problem Statement

### The real bottleneck in local agent loops

In real coding loops, agents do not execute once. They:

1. Edit files
2. Run build/tests/tools
3. Fail often
4. Revert and branch again

If each failed attempt pays full repository traversal cost, search quality gets capped by filesystem latency instead of model reasoning.

### Why existing naive approaches fail

- `git reset --hard` + `git clean -fd` scales with repository-wide inspection.
- Full-tree clone/delete (including reflink clones) still churns metadata heavily on large trees.

Hyperion's optimization target is not "faster copying" in general. It is:

- Dirty-set isolation
- Dirty-set backup
- Dirty-set restore

## 3) Solution Overview

Hyperion Delta provides a local attempt substrate with these guarantees:

- Fast checkpoint snapshots
- Mandatory pre-rollback reconcile firewall
- Path-level dirty manifest restore
- Atomic file restore semantics
- Deterministic branch lifecycle with typed conflict errors
- Durable attempt journals and recovery metadata

High-level product boundary:

- Hyperion owns: fast local attempt isolation, rollback, crash cleanup, diagnostics.
- Git owns: permanent history, branch merge, remote sync, signatures, commit workflow.

## 4) Benchmark Evidence

### Final audit benchmark (50,000-file workspace, 10 iterations)

| Runner | Avg rollback latency | Speedup vs Git |
| --- | ---: | ---: |
| Git (`reset --hard` + `clean -fd`) | `3,478.407 ms` | `1.00x` |
| Manifest restore (dirty-set only) | `0.971 ms` | `3,580.50x` |
| `rsync` link-dest restore | `50.494 ms` | `68.89x` |
| tmpfs dirty-set restore (WSL2) | `0.063 ms` | `54,851.92x` |

Raw evidence files:

- `benchmark-final-run.log`
- `benchmark-final-table.png`
- `benchmark-final-full.png`

### Dirty-set scaling sweep (Windows NTFS)

Hyperion scales with number of changed files (not repo size):

- 1 dirty file: `4.325 ms`
- 100 dirty files: `298.908 ms`

### Repo-size independence sweep

With 10 dirty files:

- 1,000-file repo: `21.326 ms`
- 5,000-file repo: `13.410 ms`

### Windows-native benchmark (no Git)

- 10,000-file repo, 10 dirty files
- Avg rollback: `62.034 ms`
- About `9.19x` faster than Git baseline on same machine (~570 ms)

### Important engineering lesson

Earlier full clone/delete design was slower than Git due to metadata thrash:

- Git average: `3,813.890 ms`
- Full clone/delete average: `16,332.289 ms`

Conclusion: metadata operations dominate; dirty-set reversion is the winning approach.

## 5) How Hyperion Works (End-to-End)

## 5.1 Attempt lifecycle

1. Create workspace/session
2. Optional FS interceptor install (default true in session wrapper)
3. Create checkpoint (`snapshot` or `fork`)
4. Agent mutates files
5. Reconcile captures child-process/native writes
6. Success path: `promote` / `promoteBranch`
7. Failure path: `rollback` / `dropBranch`
8. Dispose session/workspace

## 5.2 Baseline capture

Hybrid baseline model:

- Git index metadata when available
- Stat ledger for non-Git and general filesystem state

No full-content hashing in normal path. Content backup is path-level and dirty-set-scoped.

## 5.3 Dirty tracking channels

Hyperion merges dirty-state from:

- VFS interception (Node fs / fs/promises / callback APIs / write streams)
- Explicit `track(...)`
- `reconcile(...)` (child processes and native tools)

## 5.4 Reconcile firewall (critical)

`rollback()` always calls `reconcile()` internally before restoring.

Reason:

- Child-process and native bindings bypass monkey-patched JS fs APIs.
- Reconcile is the mandatory capture step before restore.

## 5.5 Storage strategy tiers (same correctness, different speed)

- `tmpfs` (Linux/WSL2 with writable `/dev/shm`)
- `posix-link` (same-device hard-link strategy)
- `ntfs-link` (Windows NTFS hard-link + target materialization)
- `pure-manifest` (universal copy-based fallback)

Hot Dirty Buffer overlays any physical strategy:

- Small-file in-memory backups
- Bounded by max file bytes / total bytes / max files
- Spills to underlying strategy when limits are exceeded

## 5.6 Restore semantics

- Modified/deleted files restore via temp file + atomic rename
- Created files are deleted only if manifest-listed
- Ghost directory cleaner removes empty agent-created parents safely
- Missing backup for modified/deleted file throws `HyperionIntegrityError` (fail loud, no silent corruption)

## 5.7 Branch and lineage model (P1)

Lineage metadata includes:

- `parentId`
- `branchId`
- `subagentId`
- `agentId`
- `createdBy`

Branch APIs:

- `fork(parentCheckpointId?, options?)`
- `runInBranch(branchCheckpointId, callback)`
- `promoteBranch(branchCheckpointId, options?)`
- `dropBranch(branchCheckpointId)`

Deterministic merge/conflict behavior:

- Non-overlap dirty sets: fast path
- Overlap with compatible outcomes: allowed
- Overlap with incompatible outcomes: rejected with typed `HyperionBranchConflictError`
- Conflict mode currently supported: `"reject"`

## 5.8 Durability and recovery

Checkpoint metadata is journaled to:

- `.hyperion/checkpoints/<checkpointId>/journal.json`
- backup metadata at `.hyperion/checkpoints/<checkpointId>/backups.json`

Recovery APIs:

- `recoverAttempts()`
- `rehydrateAttempt(checkpointId)`

Created-only attempts can rehydrate from metadata. Modified/deleted paths require durable backup records/files.

## 6) Public API Surface

Runtime entry points:

- `HyperionWorkspace` (core engine)
- `HyperionAgentSession` (attempt-oriented wrapper)

High-value methods:

- `snapshot`, `fork`, `reconcile`, `rollback`, `promote`, `dispose`
- `runInBranch`, `promoteBranch`, `dropBranch`
- `getCheckpointLineage`, `listCheckpointChildren`, `listBranchHeads`, `listSubagentHeads`
- `declareToolOutputs`, `track`, `getDiagnostics`
- `recoverAttempts`, `rehydrateAttempt`, `exportPatch`

High-value session helper:

- `runAttempt(callback, options?)`

This wraps snapshot/fork, callback execution, reconcile, rollback-on-throw, and diagnostics.

## 7) Safety Model

Primary safety guarantees:

- Reconcile firewall before rollback
- Atomic restore with same-directory temp + rename
- Strict typed integrity failures (`HyperionIntegrityError`)
- Optional strict ignored-write policy (`strictIgnoredWrites: true`)
- Exact allowlisting for known generated outputs (`declareToolOutputs`)

Ignored roots are excluded from broad scans for scaling:

- `node_modules/**`, `.git/**`, `.hyperion/**`, plus build/cache defaults

## 8) Reliability and Validation Evidence

Reliability command:

- `npm run test:reliability:ci`

Includes:

- threshold checks
- fuzz smoke
- reconcile fuzz
- snapshot/reconcile/rollback stress
- branch contention stress (parallel subagent promote/drop/rollback pressure)

CI reliability matrix:

- Unit matrix: Linux, Windows, macOS
- Failure injection suite
- Fuzz smoke suite
- Stress smoke suite
- Repeatability gate (Linux + Windows)

Nightly soak defaults are significantly higher than CI smoke (e.g., fuzz/stress cycles and branch contention thresholds).

## 9) Problem -> Solution Mapping (for AI Product Teams)

### Problem 1: Failed attempts are expensive

- Git-level rollback cost repeated per branch attempt

Hyperion solution:

- Dirty-set rollback and strategy-tier acceleration

### Problem 2: Native tools bypass JS interceptors

- Child processes mutate files unseen by VFS patches

Hyperion solution:

- Mandatory pre-rollback reconcile firewall

### Problem 3: Multi-agent branch contention risks corruption

- Sibling branches can touch same paths under concurrency

Hyperion solution:

- Deterministic merge planning and typed conflict rejection (`HYPERION_BRANCH_CONFLICT`)

### Problem 4: Crash/abandonment loses attempt context

Hyperion solution:

- Durable attempt journals + rehydrate flow

## 10) Example Use Cases

## 10.1 Single-agent local coding loop

```ts
import { HyperionAgentSession } from "hyperion-delta";

const session = new HyperionAgentSession(process.cwd());

try {
  const attempt = await session.runAttempt(async ({ exec }) => {
    await runAgentAttempt();
    await exec("npm", ["test"]);
  });

  await session.promote(attempt.checkpointId);
} finally {
  await session.dispose();
}
```

## 10.2 Multi-agent branch exploration

```ts
const root = await workspace.snapshot({ branchId: "main", agentId: "planner" });

const branchA = await workspace.fork(root, { branchId: "candidate-a", agentId: "agent-a" });
const branchB = await workspace.fork(root, { branchId: "candidate-b", agentId: "agent-b" });

await workspace.runInBranch(branchA, async () => {
  // mutate/test branch A
});

await workspace.runInBranch(branchB, async () => {
  // mutate/test branch B
});

// deterministic merge plan + reject-only conflict mode
await workspace.promoteBranch(branchA, { conflictMode: "reject" });
```

## 10.3 Patch export for review before Git commit

```ts
const patch = await workspace.exportPatch(checkpointId);
console.log(patch);
```

## 10.4 Tool outputs in ignored roots

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

## 11) What Hyperion Is Not

Hyperion is intentionally not:

- A replacement for Git history/merge/remotes
- A search index engine
- A package manager
- A VM/container orchestrator

This boundary is a feature: it preserves hot-path rollback performance.

## 12) Current Limitations and Mitigation Direction

From `LIMITATIONS.md`, key constraints and roadmap directions:

- No permanent history/merge: keep Git companion model
- Platform disparity: continue hardening cross-platform strategy routing and diagnostics
- Ignored-root blindspots: strict mode + exact output contracts mitigate silent drift
- Lifecycle complexity: `HyperionAgentSession.runAttempt()` reduces integration burden

## 13) Project Readiness Snapshot

As of `v0.1.7`, Hyperion Delta includes:

- Published npm package (`hyperion-delta@0.1.7`)
- Full benchmark evidence and reproducible scripts
- Deterministic branch APIs and typed conflict behavior
- Durability/recovery journal model
- Cross-platform CI reliability gates + stress/fuzz suites
- Docs for thesis, strategy tiers, safety model, API, release flow

## 14) Integration Checklist (Practical)

For teams integrating Hyperion into agent runtimes:

1. Wrap agent execution with `HyperionAgentSession.runAttempt()`.
2. Ensure child-process tools run through context `exec(...)` where possible.
3. Keep strict ignored writes enabled for production-like safety (`strictIgnoredWrites: true`).
4. Declare known generated outputs with `declareToolOutputs()`.
5. Use branch APIs for parallel exploration (`fork`, `runInBranch`, `promoteBranch`, `dropBranch`).
6. Wire diagnostics into observability dashboards (`getDiagnostics()`).
7. Run reliability gate in CI (`npm run test:reliability:ci`).

## 15) Source Map

Primary references in this repository:

- `README.md`
- `ARCHITECTURE.md`
- `LIMITATIONS.md`
- `CHANGELOG.md`
- `docs/src/content/docs/benchmark/results.md`
- `docs/src/content/docs/benchmark/windows.md`
- `docs/src/content/docs/architecture/thesis.md`
- `docs/src/content/docs/architecture/strategies.md`
- `docs/src/content/docs/architecture/safety.md`
- `docs/src/content/docs/architecture/git-companion.md`
- `docs/src/content/docs/api/workspace.md`
- `docs/src/content/docs/api/agent-session.md`
- `docs/src/content/docs/api/types.md`

---

If you need this repackaged as a startup-facing one-pager (problem -> business impact -> technical moat -> pilot plan), you can derive it directly from sections 2, 4, 9, 10, and 14.
