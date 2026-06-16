# Limitations And Mitigation Roadmap

Hyperion Delta is a dirty-set rollback engine for local agent attempts. It is not Git, not a virtual machine, not a package manager, and not a universal filesystem monitor.

That boundary is deliberate. The benchmark result comes from refusing to solve the whole repository-history problem on the hot path. Hyperion makes failed agent attempts cheap to undo; Git remains the permanent source of repository truth.

This document names the major limitations directly and records the mitigation direction for each one.

## 1. No Permanent History Or Merging

### Current Limitation

Hyperion can snapshot and roll back local workspace state, but it does not maintain permanent repository history.

It cannot:

- merge two code branches line by line
- push code to GitHub
- replace signed or cryptographic Git history
- recover arbitrary work if a snapshot ID and its manifest are lost
- decide how an experimental branch should be committed into the developer's main line

Git is slower because it solves those permanent-history problems. Hyperion is faster because it does not.

### Decided Mitigation: Git Companion Architecture

Hyperion should become the fast attempt layer under Git, not a mini Git.

Implemented foundation:

- Checkpoints now write durable attempt journals before `snapshot()` returns.
- Journals persist checkpoint metadata, selected strategy, Git HEAD, ignored patterns, baseline metadata, and dirty-entry summaries.
- `recoverAttempts()` can inspect abandoned journals from a fresh workspace/session.
- Journals intentionally do not store file contents or replace Git history.
- `exportPatch(checkpointId)` emits Git-compatible text patches for active checkpoint dirty sets.
- `rehydrateAttempt(checkpointId)` can recreate active checkpoint state when durable backup metadata proves rollback is safe.
- `recoverAttempts()` reports `canRehydrate` and a reason when an abandoned attempt is metadata-only.
- `promote(checkpointId)` finalizes successful attempts in place, marks them as promoted audit records, and frees Hyperion-owned rollback storage without running Git.

Remaining roadmap direction:

- Keep Git as the authority for commit history, merge conflict resolution, remotes, signatures, and push/pull workflows.
- Add durable mirroring for Hot Dirty Buffer memory hits when teams choose recoverability over maximum hot-path speed.
- Harden patch export for binary files, symlink diffs, and recovered checkpoint storage once persistent backup manifests exist.
- Add optional Git-adjacent adapters that can hand the returned patch or promoted dirty-set metadata to a team-owned Git workflow.
- Preserve checkpoint DAG metadata for MCTS reasoning, but treat it as attempt metadata, not repository history.

### Alternatives Considered

Building a mini VCS inside Hyperion would add branch merge semantics, conflict resolution, rename heuristics, history storage, and remote synchronization. That would duplicate Git's hardest work and put the performance-critical rollback path at risk.

Documenting the boundary only would be honest but insufficient for enterprise agent teams. They need a clean bridge from fast local attempts to durable Git workflows.

## 2. Platform Disparity And The Windows Tax

### Current Limitation

The fastest benchmark result depends on Linux `/dev/shm`:

```text
Git reset average rollback:          3,478.407 ms
Manifest targeted restore average:      0.971 ms
tmpfs dirty-set restore average:         0.063 ms
```

Linux and WSL2 can use tmpfs for RAM-backed dirty-set storage. macOS and Linux can use POSIX link strategies when device boundaries are safe. Native Windows/NTFS falls back to pure manifest copy/restore.

The semantics stay consistent, but latency is not identical across operating systems.

### Decided Mitigation: Hot Dirty Buffer

Hyperion now has the foundation for a cross-platform Hot Dirty Buffer: a bounded in-memory backup tier for small dirty files.

Implemented foundation:

- Small regular-file pre-mutation backups can be stored in process memory.
- Memory use is bounded by per-file, total-byte, and file-count limits.
- Files spill to the selected storage strategy when they exceed those bounds.
- Restore uses same-directory temp files followed by atomic rename, matching existing rollback semantics.

Remaining roadmap direction:

- Expose diagnostics showing whether a checkpoint used `tmpfs`, `hot-buffer`, `posix-link`, or `pure-manifest`.
- Explore Windows-native acceleration such as NTFS hard links, Windows Dev Drive, and ReFS block cloning.

Future conceptual strategy shape:

```ts
type StorageStrategyKind =
  | "auto"
  | "tmpfs"
  | "hot-buffer"
  | "posix-link"
  | "pure-manifest";
```

This does not make Windows identical to Linux tmpfs for every workload, but it narrows the gap for the common agent case: a small number of edited source/config/test files.

### Alternatives Considered

Windows-native acceleration should still be explored. NTFS hard links, Windows Dev Drive, and ReFS block cloning may become useful strategy tiers. They should not block the Hot Dirty Buffer because they depend on filesystem configuration and OS-specific behavior.

Accepting pure manifest fallback only is safe, but it leaves too much performance on the table for Windows-heavy teams.

## 3. Ignored Files Blindspot

### Current Limitation

Hyperion ignores dependency and generated-output folders by default:

```text
node_modules/**
.git/**
.hyperion/**
dist/**
build/**
coverage/**
.next/**
.turbo/**
.cache/**
```

This prevents initialization and reconciliation from walking dependency blackholes. It also creates a blindspot: if an agent or tool mutates an ignored path, Hyperion may not track or roll it back.

The dangerous case is silent corruption: a tool writes inside an ignored root, Hyperion skips it, and the developer later discovers the workspace is dirty.

### Decided Mitigation: Strict Ignore Policy

Hyperion keeps broad ignores for performance, but ignored writes can now become explicit and auditable.

Implemented foundation:

- Keep ignored roots excluded from broad baseline scans and broad reconciliation walks.
- `strictIgnoredWrites: true` throws `HyperionIgnoredPathError` before VFS-captured writes mutate ignored roots.
- Non-strict VFS ignored writes are recorded internally for diagnostics while preserving current write behavior.
- Exact ignored paths can be passed to `track()` for future tool-adapter integrations.
- `declareToolOutputs()` lets integrations declare exact generated or ignored output paths for package managers, build systems, formatters, and codegen tools.
- Declared outputs bypass strict ignored-write blocking, become VFS backup-aware, and are explicitly statted during reconciliation without scanning the ignored root.

Remaining roadmap direction:

- Persist tool-output contracts in durable journals for abandoned-attempt recovery.
- Add curated contract helpers for known tools while keeping the primitive exact-path based.
- Make ignored-write diagnostics visible in `ReconcileResult` or session diagnostics.

Current strict configuration shape:

```ts
const workspace = new HyperionWorkspace({
  workspaceRoot: process.cwd(),
  strictIgnoredWrites: true,
  ignoredPatterns: ["node_modules/**", ".next/**"],
});

workspace.track("node_modules/.cache/specific-tool/output.json");

workspace.declareToolOutputs({
  toolName: "vite",
  outputs: [
    "node_modules/.cache/vite/deps_metadata.json",
    { path: ".next/build-manifest.json", optional: true },
  ],
});
```

### Alternatives Considered

Scanning more ignored folders would improve coverage but break the core scaling law. A dependency tree can contain hundreds of thousands of files. Broadly walking it to protect against rare mutations would recreate the metadata bottleneck Hyperion exists to avoid.

Leaving ignores as documentation-only guidance is not strong enough. Enterprise users need failures that are loud, typed, and actionable.

## 4. Agent-Team Lifecycle Complexity

### Current Limitation

Calling Git is structurally simple:

```ts
execSync("git reset --hard");
```

Hyperion is more powerful but introduces lifecycle responsibilities:

- create checkpoints before attempts
- reconcile after child-process or native-tool execution
- roll back the right checkpoint
- manage parallel checkpoint locks during MCTS search
- dispose sessions and storage namespaces
- understand strategy diagnostics and ignored-path behavior

The core API is intentionally small, but agent teams should not need to manually remember every safety step.

### Decided Mitigation: Autopilot Runner

Hyperion now moves the normal attempt lifecycle into a high-level runner API.

Implemented foundation:

- `HyperionAgentSession.runAttempt()` handles snapshot, attempt execution, reconciliation, rollback-on-failure, timing, and diagnostics.
- `HyperionAgentSession.exec()` and attempt-context `exec()` run explicit executable-plus-args child processes without shell-string execution.
- Context `exec()` reconciles the active checkpoint after command completion.
- Low-level `snapshot()`, `reconcile()`, `rollback()`, and `dispose()` remain available for advanced integrations.

Remaining roadmap direction:

- Make `runAttempt()` the recommended Prettiflow integration path.
- Make cleanup automatic through existing lifecycle hooks, while still exposing explicit `dispose()`.

Current API shape:

```ts
const session = new HyperionAgentSession(process.cwd());

await session.runAttempt(async ({ checkpointId, exec }) => {
  await agentMutatesFiles();
  await exec("npm", ["test"]);
  return { checkpointId };
});
```

Failure path concept:

```ts
await session.runAttempt(async ({ exec }) => {
  await exec("npm", ["test"]);
}, {
  rollbackOnThrow: true,
});
```

### Alternatives Considered

Docs-only lifecycle guidance would reduce API growth but leave correctness dependent on every agent engineer remembering every step.

A Prettiflow-only adapter could be extremely ergonomic, but the underlying lifecycle problem is general. The reusable SDK should solve it first, then Prettiflow can wrap the same runner.

## North Star

Hyperion's job is not to replace Git. Its job is to make local agent attempts cheap, isolated, observable, and reversible.

The target architecture is:

```text
Git
  owns permanent history, merge, remotes, signatures, and push

Hyperion
  owns fast local attempt isolation, dirty-set rollback, crash cleanup, and agent-loop ergonomics

Agent framework
  owns task planning, tool execution, evaluation, and promotion decisions
```

The strongest version of Hyperion is therefore a Git companion with:

- durable attempt journals
- patch export and Git promotion hooks
- cross-platform hot dirty buffers
- strict ignored-root safety
- autopilot attempt runners
- honest strategy diagnostics

That direction preserves the benchmark's core win: rollback latency scales with the dirty set, not the repository.
