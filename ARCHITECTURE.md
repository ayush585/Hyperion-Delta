# Hyperion Delta Production SDK Architecture

Enterprise-grade, zero-config local agent state management for `hyperion-delta`.

## 1. Executive Thesis

Most local coding agents use Git as their state-recovery primitive. That makes rollback scale with repository size: Git must inspect the working tree, clean untracked files, and traverse metadata across large file systems. Hyperion Delta changes the scaling law. It makes rollback scale with the dirty set: the files the agent actually touched.

Search systems such as Cursor's instant grep optimize read I/O. Hyperion Delta optimizes write and metadata I/O. Its job is not to help an agent find code; its job is to let an agent safely mutate, test, fail, backtrack, and try again without corrupting the developer's workspace or spending seconds in filesystem traversal.

The benchmark evidence in this repository uses a 50,000-file TypeScript workspace with 10 rollback iterations:

```text
Git reset average rollback:          3,478.407 ms
Manifest targeted restore average:      0.971 ms   3580.50x faster
tmpfs dirty-set restore average:         0.063 ms  54851.92x faster
```

Evidence files:

- `benchmark-final-run.log`
- `benchmark-final-table.png`
- `benchmark-final-full.png`

The earlier full-tree clone/delete design failed for the right reason. Reflink cloning avoids copying file blocks, but deleting and recreating 50,000 directory entries still triggers inode metadata churn. On the WSL2 XFS loopback test, full directory clone/delete averaged `16,332.289 ms`, slower than Git's `3,813.890 ms` average. The production SDK must never use whole-workspace clone/delete as the hot rollback path.

## 2. Product Boundary

Hyperion Delta is a Node.js/TypeScript SDK for local agent execution loops. It is not a Git replacement, a search index, a package manager, or a virtual machine. It owns one boundary: fast, safe rollback of local filesystem mutations made during an agent attempt.

The SDK is packaged as:

```ts
import { HyperionWorkspace } from "hyperion-delta";
```

The target integration has zero operational knobs for the agent engineer:

```ts
const workspace = new HyperionWorkspace(process.cwd());
workspace.installFsInterceptor();

const checkpointId = await workspace.snapshot();

try {
  await agentAttempt();
  await runTests();
} catch {
  await workspace.reconcile(checkpointId);
  await workspace.rollback(checkpointId);
} finally {
  await workspace.dispose();
}
```

## 3. Hyperion Delta vs Cursor Instant Grep

| Vector | Cursor Instant Grep | Hyperion Delta |
| --- | --- | --- |
| Primary domain | Read I/O optimization | Write and metadata I/O optimization |
| Problem solved | Find code strings across large codebases without blocking the editor | Safely mutate, test, and roll back file trees during automated execution |
| Underlying technology | Parallel scanners, search indexes, embeddings, vector stores | Dirty-set manifests, tmpfs caches, hard links, atomic rename, stat ledgers |
| Agent value | Helps the LLM find context before patching | Lets the agent test and backtrack without Git-scale rollback latency |
| Scaling law | Scales with indexed corpus and query pattern | Scales with dirty-set size, not repository size |

The moat is write isolation. Any agent can call a fast search utility. Hyperion provides the local execution substrate that lets the agent run experimental build-and-test loops without leaving dirty workspaces behind.

## 4. Public SDK API

### 4.1 Types

```ts
export type CheckpointId = string;

export interface HyperionConfig {
  workspaceRoot: string;
  useTmpfs?: boolean;
  ignoredPatterns?: string[];
  overrideDefaultIgnores?: boolean;
  enableFsInterceptor?: boolean;
  maxConcurrentCheckpoints?: number;
  sessionRoot?: string;
}

export interface ReconcileResult {
  checkpointId: CheckpointId;
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}
```

### 4.2 Class Surface

```ts
export class HyperionWorkspace {
  constructor(rootOrConfig: string | HyperionConfig);

  track(pathOrPaths: string | string[]): void;
  snapshot(): Promise<CheckpointId>;
  rollback(checkpointId: CheckpointId): Promise<void>;
  reconcile(checkpointId?: CheckpointId): Promise<ReconcileResult>;
  dispose(): Promise<void>;

  installFsInterceptor(): void;
  uninstallFsInterceptor(): void;

  readonly root: string;
  readonly strategy: StorageStrategyKind;
}
```

### 4.3 Method Semantics

`track(path | paths)` manually registers paths as dirty. This is required for non-Node writes, direct shell commands, and integrations that choose not to use monkey-patching.

`snapshot()` creates an isolated checkpoint. It captures a hybrid baseline using Git index data when available plus a lightweight stat ledger for files outside Git's tracked set. Multiple active checkpoints are allowed.

`reconcile(checkpointId?)` reruns the Hybrid State Tracking Engine and updates the dirty-set for mutations that bypassed the VFS interceptor. This is mandatory after child processes such as `tsc`, `npm install`, formatters, codegen, test runners, and shell commands. It is also the mitigation for native C++/Rust/Go bindings such as `esbuild`, `oxc`, SWC, Python extensions, and native package-manager helpers, because those writes do not pass through monkey-patched JavaScript `fs` functions. If `checkpointId` is omitted, reconciliation applies to the most recent active checkpoint.

`rollback(checkpointId)` restores only paths dirty relative to that checkpoint. It must not delete or recreate the whole workspace. Before restoring, it MUST internally await `reconcile(checkpointId)` by default. That pre-rollback reconciliation is an unbypassable firewall for native-binding and child-process mutations.

`dispose()` unregisters interceptors, releases strategy resources, and removes active session scratch data.

`installFsInterceptor()` monkey-patches Node `fs` and `fs/promises` mutation APIs. It is v1 default behavior when `enableFsInterceptor !== false`.

`uninstallFsInterceptor()` restores the original Node module functions exactly once. It is idempotent.

## 5. Runtime Lifecycle

```text
Node.js Agent Process
        |
        | 1. new HyperionWorkspace(root)
        v
Environment Discovery
        |
        | 2. select fastest safe strategy
        v
Strategy Router
        |
        +--> Tier 1: Linux/WSL2 tmpfs dirty-set cache
        +--> Tier 2: macOS/Linux hard-link-backed cache
        +--> Tier 3: pure Node manifest cache
        |
        | 3. install fs interceptor
        v
snapshot()
        |
        | 4. Git index baseline + stat ledger
        v
Concurrent Checkpoint Store
        |
        | 5. agent mutates files
        |    - fs interceptor captures Node writes
        |    - track() captures explicit paths
        |    - reconcile() captures child-process writes
        v
Dirty Manifest
        |
        +--> test passes: dispose checkpoint or commit result
        |
        +--> test fails: rollback(checkpointId)
                 |
                 v
           Atomic Rollback Engine
                 |
                 v
           Ghost Directory Cleaner
                 |
                 v
           clean workspace state
```

## 6. Component Architecture

### 6.1 Workspace Core

The Workspace Core owns process-level state:

- canonical workspace root
- environment profile
- selected storage strategy
- active checkpoint registry
- lifecycle hooks
- interceptor installation state
- ignore matcher

The core must treat all public APIs as workspace-relative even when callers pass absolute paths. Paths outside the root are rejected unless an explicit advanced escape hatch is added later.

### 6.2 Environment Discovery

Environment Discovery determines:

- `process.platform`
- WSL2 detection via `/proc/version`
- `/dev/shm` availability and writability
- `rsync` availability
- Git repository presence
- workspace mount type when detectable
- default `sessionRoot`, which is `.hyperion/checkpoints/` inside the workspace unless explicitly configured
- physical device IDs for `workspaceRoot` and `sessionRoot` via `fs.statSync(path).dev`
- case sensitivity behavior
- temp directory location

Discovery is read-only except for ensuring the Hyperion-owned session root exists when needed. It must never mutate user source files. Device ID discovery is mandatory before selecting a link-based strategy because hard links cannot cross filesystem devices.

### 6.3 Strategy Selector

The selector always preserves semantics and only changes storage performance:

```ts
interface StorageStrategy {
  kind: StorageStrategyKind;
  initialize(session: HyperionSession): Promise<void>;
  backupFile(checkpointId: CheckpointId, relativePath: string): Promise<void>;
  restoreFile(checkpointId: CheckpointId, relativePath: string): Promise<void>;
  deleteBackup(checkpointId: CheckpointId, relativePath: string): Promise<void>;
  cleanup(checkpointId?: CheckpointId): Promise<void>;
}
```

Selection order:

1. `TmpfsDirtySetStrategy` on Linux/WSL2 when `/dev/shm` is writable and `useTmpfs !== false`.
2. `PosixLinkStrategy` on macOS/Linux when `fs.statSync(workspaceRoot).dev === fs.statSync(sessionRoot).dev`.
3. `PureManifestStrategy` everywhere else, including Windows/NTFS.

The strategy must never expose raw shell commands to agent code.

`PosixLinkStrategy` must proactively prevent `EXDEV` failures. The default `sessionRoot` is a hidden directory inside the project, `.hyperion/checkpoints/`, specifically so the workspace and session data share the same physical device. If the user configures `sessionRoot` outside the workspace, the selector must compare `stat.dev` values. If they differ, Tier 2 is unsafe and the selector must gracefully degrade to `PureManifestStrategy`.

### 6.4 Hybrid State Engine

The Hybrid State Engine builds the authoritative baseline and later computes dirty sets.

Git path:

- Run `git ls-files --stage` to capture tracked paths and object metadata.
- Use Git as the source of truth for tracked files.
- Do not run `git reset`, `git clean`, or whole-tree Git status as rollback primitives.

Filesystem stat path:

- For untracked, ignored, generated, and pre-existing dirty files, record:
  - workspace-relative path
  - type: file, directory, symlink
  - size
  - `mtimeMs`
  - mode where useful
- Do not hash file contents in the default path.
- Read file content only when a path is dirty and needs to be backed up or restored.

Fallback path:

- If Git is unavailable or the root is not a Git repository, build a stat-only manifest over included files.
- Honor default ignores before walking the filesystem.

### 6.5 Default Ignore Model

`HyperionConfig` must include default ignore behavior. The engine must not track dependency blackholes by default.

Required default ignores:

```text
node_modules/**
.git/**
.hyperion/**
```

Recommended built-in ignores:

```text
.pnpm-store/**
.yarn/cache/**
.npm/**
dist/**
build/**
coverage/**
.next/**
.turbo/**
.cache/**
```

User `ignoredPatterns` extend the default list. Defaults are disabled only when `overrideDefaultIgnores === true`, and that option must be documented as dangerous for enterprise monorepos.

Ignore checks apply to:

- snapshot baseline scans
- reconcile scans
- VFS interception
- manual `track()`
- ghost directory cleanup boundaries

### 6.6 Dirty Manifest

The Dirty Manifest is checkpoint-scoped. It records what changed relative to that checkpoint:

```ts
interface DirtyEntry {
  relativePath: string;
  kind: "created" | "modified" | "deleted" | "renamed" | "metadata";
  fileType: "file" | "directory" | "symlink" | "unknown";
  before?: StatLedgerEntry;
  after?: StatLedgerEntry;
  renameFrom?: string;
  renameTo?: string;
  capturedBy: "vfs" | "track" | "reconcile";
  firstSeenAt: number;
  lastSeenAt: number;
}
```

The manifest must be append-tolerant and idempotent. If the same path is captured by the VFS interceptor and then by `reconcile()`, the entries merge into one canonical dirty entry.

### 6.7 Concurrent Checkpoint Store

Parallel MCTS agent reasoning requires multiple active checkpoints.

```ts
interface Checkpoint {
  id: CheckpointId;
  parentId?: CheckpointId;
  createdAt: number;
  baseline: StateManifest;
  dirty: Map<string, DirtyEntry>;
  storageNamespace: string;
  lock: AsyncCheckpointLock;
  status: "active" | "rolling-back" | "disposed";
}
```

Rules:

- Each checkpoint has an isolated manifest.
- Each checkpoint has an isolated storage namespace.
- Rollback locks only the target checkpoint plus the paths it will mutate.
- Sibling checkpoints must not share mutable manifest objects.
- A checkpoint can have a parent checkpoint for MCTS tree structure, but rollback is always explicitly targeted by `CheckpointId`.
- `snapshot()` returns a unique ID using `crypto.randomUUID()`.
- If `maxConcurrentCheckpoints` is reached, `snapshot()` must first trigger an aggressive garbage-collection sweep to purge disposed checkpoints, stale session directories, orphaned temp files, and abandoned lockfiles. Only if capacity is still exhausted after GC may `snapshot()` reject with a typed capacity error.
- The default `maxConcurrentCheckpoints` must be finite in production builds so high-frequency MCTS loops cannot exhaust inodes inside Docker, CI, or small tmpfs mounts.

### 6.8 Storage Strategies

#### Tier 1: Tmpfs Dirty-Set Strategy

Use `/dev/shm` for dirty-set backup content on Linux/WSL2. Do not clone the full workspace into tmpfs. Only files touched by the agent are copied into the RAM-backed checkpoint namespace.

Namespace:

```text
/dev/shm/hyperion-delta/<session-id>/<checkpoint-id>/
```

This provides memory-speed restore for dirty files while avoiding `/dev/shm` exhaustion on large monorepos.

#### Tier 2: Posix Link Strategy

Use hard links to create cheap dirty-set backups on macOS/Linux when tmpfs is unavailable. If hard-link setup fails at runtime, the strategy falls back to copy semantics for that and subsequent backup paths.

This strategy still operates only on dirty files. It must not full-clone the workspace during rollback.

Tier 2 is allowed only when the workspace and checkpoint storage live on the same device. The implementation must validate `fs.statSync(workspaceRoot).dev === fs.statSync(sessionRoot).dev` during strategy selection. If this check fails, hard-link behavior can throw `EXDEV`; the selector must skip Tier 2 and use `PureManifestStrategy`.

#### Tier 3: Pure Manifest Strategy

Use Node `fs.copyFile`, temp files, and atomic `rename`. This is the universal baseline for Windows/NTFS and restricted environments.

The pure strategy is slower than tmpfs but still scales with the dirty set rather than repository size.

### 6.9 Atomic Rollback Engine

Rollback is path-targeted and checkpoint-specific:

1. Acquire checkpoint lock.
2. Await `reconcile(checkpointId)`.
3. Load dirty entries.
4. For created files, delete the created path.
5. For modified files, restore backup content through atomic temp replacement.
6. For deleted files, recreate the file from backup content.
7. For renames, move paths back through temp-safe operations.
8. Run Ghost Directory Cleaner.
9. Mark checkpoint clean or disposed.
10. Release lock.

Atomic restore rule:

```text
target.ext
target.ext.hyperion-<checkpoint-id>.tmp
```

Write the full restored content to the temp file in the target directory, fsync where available, then `rename` over the target. Same-directory rename preserves atomicity on POSIX and gives the best available behavior on Windows.

Rollback must not corrupt the target if the process dies halfway through writing the temp file. Startup garbage collection removes leftover temp files.

The pre-rollback `reconcile(checkpointId)` call is mandatory and must not be skipped by public API callers. It protects rollback correctness when the agent invoked native tools that bypass Node VFS interception.

### 6.10 Ghost Directory Cleaner

Agent-created scratch files can leave empty parent directories after rollback. The Rollback Engine must remove those directories bottom-up.

Algorithm:

1. For each deleted created file or directory, start at its parent directory.
2. Walk upward toward the workspace root.
3. At each directory:
   - stop if it existed in the checkpoint baseline
   - stop if it is not empty
   - stop if it matches an ignore boundary or workspace root
   - otherwise remove it
4. Continue until a stop condition is reached.

This reverse-walk prevents ghost directories such as `tmp/agent/run-42/output/` from surviving after all agent-created files inside them are removed.

### 6.11 VFS Interceptor

The VFS Interceptor is v1 default. It monkey-patches Node mutation APIs in both `fs` and `fs/promises`.

Intercepted classes:

- write: `writeFile`, `appendFile`, `write`, `writev`, `truncate`, `createWriteStream`
- delete: `unlink`, `rm`
- move: `rename`
- copy: `copyFile`
- links: `symlink`, `link`
- directory create: `mkdir`
- metadata: `chmod`, `fchmod`, `utimes`, `futimes`

The interceptor records the path before executing the original operation. For renames, it records both source and destination.

Requirements:

- Preserve original function signatures as closely as possible.
- Preserve callback behavior.
- Preserve thrown errors.
- Be idempotent.
- Support uninstall.
- Ignore paths outside the workspace.
- Ignore configured ignore patterns.

Blindspot:

- Monkey-patching JavaScript `fs` cannot observe file writes performed by native C++/Rust/Go code, spawned binaries, Python extensions, or package-manager internals.
- Examples include `esbuild`, `oxc`, SWC, native npm lifecycle scripts, Python build extensions, and arbitrary child processes.
- The mitigation is not optional: `rollback(checkpointId)` must call `reconcile(checkpointId)` internally before restore begins.

### 6.12 Reconciliation Engine

Child processes bypass Node VFS interception. The Reconciliation Engine closes that gap.

`workspace.reconcile(checkpointId?)`:

- selects the target checkpoint
- reruns Hybrid State Engine against the checkpoint baseline
- compares Git index state plus stat ledger
- detects created, modified, deleted, and renamed paths
- applies default ignores
- merges changes into the checkpoint dirty manifest
- returns `ReconcileResult`

This must be called after:

- `npm install`
- `pnpm install`
- `tsc`
- `tsc --build`
- formatters
- code generators
- test runners that write snapshots
- shell commands
- child-process agent tools
- native C++/Rust/Go tooling such as `esbuild`, `oxc`, and SWC
- Python extensions or native package-manager hooks

`rollback()` MUST call `reconcile(checkpointId)` by default immediately before rollback so external and native mutations are not missed. This is the mandatory native-binding firewall.

### 6.13 Lifecycle Cleanup and Garbage Collection

The SDK registers lifecycle hooks:

```ts
process.once("exit", cleanupSync);
process.once("SIGINT", signalCleanupSync);
process.once("SIGTERM", signalCleanupSync);
process.once("SIGHUP", signalCleanupSync);
process.once("uncaughtException", crashCleanupSync);
process.once("unhandledRejection", crashCleanupSync);
```

Cleanup rules:

- Synchronous cleanup must never throw.
- Restore permissions before deleting session directories.
- Remove tmpfs dirty-set caches.
- Remove `.hyperion/session-*` scratch directories.
- Remove leftover `.tmp` files created by atomic rollback.
- Do not delete user files outside known Hyperion namespaces.

Startup garbage collection scans known Hyperion session roots and deletes stale sessions whose owner process no longer exists or whose lockfile is expired.

High-frequency MCTS loops can create many checkpoint namespaces quickly. Garbage collection must therefore be callable from `snapshot()` as well as startup and shutdown paths. When inode pressure or `maxConcurrentCheckpoints` pressure is detected, the GC sweep must aggressively remove disposed checkpoints before allowing a new checkpoint or throwing a capacity error.

## 7. Data Model

```ts
type CheckpointId = string;

interface HyperionConfig {
  workspaceRoot: string;
  useTmpfs?: boolean;
  ignoredPatterns?: string[];
  overrideDefaultIgnores?: boolean;
  enableFsInterceptor?: boolean;
  maxConcurrentCheckpoints?: number;
  sessionRoot?: string;
}

interface StateManifest {
  gitAvailable: boolean;
  gitHead?: string;
  gitIndexEntries: Map<string, GitIndexEntry>;
  statEntries: Map<string, StatLedgerEntry>;
  ignoredPatterns: string[];
  capturedAt: number;
}

interface StatLedgerEntry {
  relativePath: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mtimeMs: number;
  mode?: number;
}

interface GitIndexEntry {
  relativePath: string;
  mode: string;
  objectId: string;
  stage: number;
}

interface Checkpoint {
  id: CheckpointId;
  parentId?: CheckpointId;
  baseline: StateManifest;
  dirty: Map<string, DirtyEntry>;
  storageNamespace: string;
  deviceId?: number;
  status: "active" | "rolling-back" | "disposed";
  createdAt: number;
}

interface DirtyEntry {
  relativePath: string;
  kind: "created" | "modified" | "deleted" | "renamed" | "metadata";
  fileType: "file" | "directory" | "symlink" | "unknown";
  before?: StatLedgerEntry;
  after?: StatLedgerEntry;
  renameFrom?: string;
  renameTo?: string;
  capturedBy: "vfs" | "track" | "reconcile";
  firstSeenAt: number;
  lastSeenAt: number;
}

interface ReconcileResult {
  checkpointId: CheckpointId;
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}
```

## 8. Failure Model

### Interrupted Rollback

If rollback is interrupted, temp files may remain. Startup garbage collection removes `.hyperion-*.tmp` files. Since restored content is committed by atomic rename, partially written temp files do not corrupt target files.

### Stale Session Cleanup

Every session writes a lockfile with PID, hostname, start time, and SDK version. Startup GC deletes stale sessions when the owner process is gone or the lockfile is expired.

### Child-Process Mutation

External tools bypass VFS interception. `reconcile()` is the authoritative repair path. `rollback()` calls it by default before restoring.

### Native-Binding Blindspot

Native C++/Rust/Go/Python code does not use monkey-patched JavaScript `fs` APIs. Tools such as `esbuild`, `oxc`, SWC, Python extensions, native npm scripts, and compiled package-manager helpers can write files without the VFS interceptor observing them. Hyperion mitigates this by making pre-rollback reconciliation mandatory. `rollback(checkpointId)` MUST internally await `reconcile(checkpointId)` before reading the dirty manifest or restoring files. Public callers cannot disable this firewall.

### File Created After Snapshot

Created files are removed during rollback. Their empty parent directories are removed by Ghost Directory Cleaner.

### File Deleted After Snapshot

Deleted files are restored from checkpoint backup storage. If backup content is missing, rollback fails with a typed integrity error and does not continue silently.

### Rename Or Move

Renames are represented as a paired delete/create when exact rename detection is uncertain. When the interceptor sees `rename(from, to)`, it records a strong rename entry.

### Permission Failures

Rollback first attempts permission repair for files inside Hyperion namespaces. It does not chmod arbitrary user files unless that file is part of the dirty-set restore target.

### Git Unavailable

The engine falls back to stat-only filesystem manifests with default ignores. Correctness remains, startup may be slower on very large non-Git workspaces.

### Rsync Unavailable (Benchmark Tooling)

Benchmark rows that invoke `rsync` are skipped when `rsync` is missing. SDK runtime strategy selection is unaffected.

### Cross-Device Link Failure

Hard-link storage cannot cross physical device boundaries. If `workspaceRoot` and `sessionRoot` have different `fs.statSync().dev` values, Tier 2 can fail with `EXDEV`. The default `sessionRoot` is `.hyperion/checkpoints/` inside the workspace to prevent this. If a configured `sessionRoot` is on another device, Strategy Selector must skip `PosixLinkStrategy` and degrade to `PureManifestStrategy`.

### Tmpfs Unavailable Or Too Small

The selector skips Tier 1 and falls back to Tier 2 or Tier 3. Tmpfs mode stores only dirty-set content, not whole workspaces, to minimize memory pressure.

### Inode Exhaustion In CI/CD

Docker containers, CI workers, and small tmpfs mounts may run out of inodes before bytes. MCTS loops are especially risky because they create many checkpoint namespaces. Hyperion must strictly enforce `maxConcurrentCheckpoints`. When the limit is reached, `snapshot()` must run an aggressive GC sweep for disposed checkpoints, stale sessions, abandoned temp files, and expired locks. If the limit is still exceeded after GC, `snapshot()` throws a typed capacity error instead of creating another checkpoint.

### Concurrent Checkpoint Collision

Each checkpoint has isolated namespace and manifest state. Path-level rollback locks prevent two rollback operations from mutating the same target path at the same time.

## 9. Implementation Roadmap

### Phase 1: MVP SDK

- Package scaffold for `hyperion-delta`.
- `HyperionWorkspace` public API.
- Hybrid Git/stat baseline.
- Pure Node manifest strategy.
- Atomic rollback and ghost directory cleanup.
- Default ignores.
- Same-device session root validation for EXDEV-safe strategy selection.

### Phase 2: Strategy Acceleration

- Tmpfs dirty-set cache.
- POSIX hard-link strategy with safe copy fallback.
- Environment diagnostics.
- Strategy selection test matrix across Linux, WSL2, macOS, and Windows.

### Phase 3: VFS Interception Hardening

- Patch `fs` and `fs/promises`.
- Support write streams and callback APIs.
- Provide uninstall and test isolation.
- Add explicit warnings for unsupported native addons or non-Node processes.

### Phase 4: Reconciliation And Child Processes

- Implement `reconcile()`.
- Add child-process integration examples.
- Detect test snapshots, generated files, and package manager outputs without tracking ignored dependency trees.
- Enforce mandatory pre-rollback reconciliation for native-binding blindspots.

### Phase 5: MCTS Concurrency

- Concurrent checkpoint store.
- Parent checkpoint metadata.
- Path-level rollback locks.
- Stress tests for parallel agent branches.
- Inode-pressure GC and `maxConcurrentCheckpoints` capacity behavior.

### Phase 6: Prettiflow Integration And Publishing

- Integrate into Prettiflow CLI startup.
- Publish package.
- Add benchmark suite.
- Add enterprise diagnostics and debug logs.

## 10. Acceptance Checklist

The SDK implementation derived from this document is acceptable only if:

- Agent engineers can use `snapshot()`, `rollback()`, `reconcile()`, and `dispose()` without selecting OS strategies.
- Default ignores prevent tracking `node_modules/**`, `.git/**`, and `.hyperion/**`.
- Rollback touches only dirty files and ghost directories, never the full workspace.
- Rollback uses temp files and atomic rename for restored content.
- Child-process mutations are captured by `reconcile()`.
- Native C++/Rust/Go/Python mutations are caught by mandatory pre-rollback reconciliation.
- Tier 2 link strategy is selected only when `workspaceRoot` and `sessionRoot` share `fs.statSync().dev`.
- Multiple checkpoints can exist concurrently for MCTS search.
- `maxConcurrentCheckpoints` is enforced and triggers GC before capacity errors.
- VFS interception can be installed and uninstalled safely.
- Crashes do not leave persistent tmpfs caches or `.hyperion/session-*` directories.
- Linux/WSL2, macOS, and Windows share the same correctness semantics.
