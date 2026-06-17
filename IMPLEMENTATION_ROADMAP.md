# Hyperion Delta Implementation Roadmap

This roadmap turns `ARCHITECTURE.md` into a production SDK in small, high-quality phases. Each phase is intentionally narrow enough to review, test, and reason about independently. The goal is not speed of shipping at the expense of correctness; the goal is to build a filesystem safety layer that Prettiflow can trust inside real developer workspaces.

This file is intentionally ignored by Git. It is the local engineering execution plan, not the public architecture artifact.

## Engineering Principles

- Build correctness before acceleration. Tier 3 pure Node targeted restore must be correct before tmpfs or hard-link acceleration matters.
- Never use full workspace clone/delete on the hot rollback path.
- Treat rollback as a safety-critical operation. A failed rollback must fail loudly before corrupting source files.
- Keep the public API stable from the first SDK scaffold: `track`, `snapshot`, `rollback`, `reconcile`, `dispose`, `installFsInterceptor`, `uninstallFsInterceptor`.
- Every phase must leave the package in a runnable state with focused tests.
- Use small internal interfaces so strategies can be tested with fake filesystems and real temp directories.
- Default to conservative behavior on unknown platforms.

## Phase 0: Repository And Package Scaffold

### Objective

Convert the benchmark repository into a real TypeScript SDK workspace without losing the benchmark evidence or architecture context.

### Implementation Parts

1. Create package metadata.
   - Add `package.json` with name `@prettiflow/hyperion-delta`.
   - Use ESM-first TypeScript output unless a Prettiflow integration requires CJS.
   - Add scripts:
     - `build`
     - `typecheck`
     - `test`
     - `test:watch`
     - `lint` only if lint tooling is introduced deliberately.

2. Add TypeScript config.
   - Add `tsconfig.json`.
   - Set strict mode on.
   - Emit declarations.
   - Keep source under `src/`.
   - Emit to `dist/`.

3. Add test harness.
   - Prefer `vitest` for fast filesystem tests.
   - Tests should use OS temp directories, not the repo root.
   - Add helpers for creating fake Git and non-Git workspaces.

4. Preserve benchmark artifacts.
   - Keep `benchmark.ts` as a standalone empirical harness.
   - Keep benchmark screenshots and logs as evidence.
   - Do not let SDK internals depend on benchmark code.

### Files To Introduce

- `package.json`
- `tsconfig.json`
- `src/index.ts`
- `src/workspace.ts`
- `src/types.ts`
- `test/fixtures.ts`

### Acceptance Gates

- `npm install` succeeds.
- `npm run typecheck` succeeds.
- Empty SDK exports compile.
- Existing `benchmark.ts` remains runnable.

## Phase 1: Public API And Type Contracts

### Objective

Lock the SDK surface so all later implementation work targets stable contracts.

### Implementation Parts

1. Define public types.
   - `CheckpointId`
   - `HyperionConfig`
   - `ReconcileResult`
   - `StorageStrategyKind`
   - `HyperionError`
   - typed error subclasses for capacity, integrity, path escape, and rollback failure.

2. Implement `HyperionWorkspace` shell.
   - Constructor accepts `string | HyperionConfig`.
   - Normalize `workspaceRoot`.
   - Reject non-existent roots.
   - Reject file roots.
   - Resolve default config.

3. Add default ignores.
   - Required:
     - `node_modules/**`
     - `.git/**`
     - `.hyperion/**`
   - Recommended defaults:
     - `.pnpm-store/**`
     - `.yarn/cache/**`
     - `.npm/**`
     - `dist/**`
     - `build/**`
     - `coverage/**`
     - `.next/**`
     - `.turbo/**`
     - `.cache/**`
   - `ignoredPatterns` extends defaults unless `overrideDefaultIgnores === true`.

4. Add no-op lifecycle methods.
   - `track`
   - `snapshot`
   - `rollback`
   - `reconcile`
   - `dispose`
   - `installFsInterceptor`
   - `uninstallFsInterceptor`

### Acceptance Gates

- Type tests compile against the intended API.
- `new HyperionWorkspace(process.cwd())` works.
- Path outside root is rejected by internal path normalization helper.
- Default ignores are present and unit-tested.

## Phase 2: Path, Ignore, And Session Root Foundation

### Objective

Build the safety foundation before touching rollback.

### Implementation Parts

1. Path normalization.
   - Convert absolute and relative inputs to normalized workspace-relative paths.
   - Reject `..` escapes.
   - Normalize separators to POSIX-style internal paths.
   - Preserve platform-specific actual paths only at I/O boundary.

2. Ignore engine.
   - Implement glob matcher.
   - Apply ignores to:
     - `track`
     - snapshot scans
     - reconcile scans
     - VFS interception
     - ghost directory cleanup.

3. Session root resolution.
   - Default `sessionRoot` to `<workspaceRoot>/.hyperion/checkpoints`.
   - Ensure the directory exists lazily.
   - Store Hyperion-owned lockfiles and checkpoint namespaces there.

4. Device ID probing.
   - Use `fs.statSync(workspaceRoot).dev`.
   - Use `fs.statSync(sessionRoot).dev`.
   - Expose internal `sameDevice` boolean for strategy selection.

### Acceptance Gates

- Windows-style and POSIX-style paths normalize correctly.
- Ignored files are not tracked.
- `.hyperion/checkpoints` is created only when needed.
- Device ID check is covered by unit tests with mocked `stat.dev`.

## Phase 3: Environment Discovery And Strategy Selector

### Objective

Select the fastest safe strategy without changing public behavior.

### Implementation Parts

1. Environment profile.
   - `platform`
   - `isWsl2`
   - `hasDevShm`
   - `devShmWritable`
   - `hasRsync`
   - `gitAvailable`
   - `sameDeviceForLinks`
   - `caseSensitive`

2. Strategy selector.
   - Tier 1: `TmpfsDirtySetStrategy` if Linux/WSL2 and `/dev/shm` usable.
   - Tier 2: `PosixLinkStrategy` only if macOS/Linux, links available, and `workspaceRoot.dev === sessionRoot.dev`.
   - Tier 3: `PureManifestStrategy`.

3. EXDEV prevention.
   - Do not attempt links if device IDs differ.
   - Gracefully degrade to Tier 3.
   - Log diagnostic metadata internally if debug mode exists later.

### Acceptance Gates

- Selector chooses Tier 3 on Windows.
- Selector skips Tier 2 when device IDs differ.
- Selector picks Tier 1 on Linux when `/dev/shm` is available.
- No strategy selection path mutates user files.

## Phase 4: Hybrid State Engine

### Objective

Create fast checkpoint baselines using Git plus lightweight stat ledgers.

### Implementation Parts

1. Git index baseline.
   - Run `git ls-files --stage`.
   - Parse mode, object ID, stage, and path.
   - Do not run `git reset` or `git clean`.
   - If Git command fails, fall back to stat-only mode.

2. Stat ledger.
   - Walk included files.
   - Record path, type, size, `mtimeMs`, and mode.
   - Do not hash file contents by default.
   - Skip ignored patterns.

3. Unified manifest.
   - Merge Git tracked baseline and stat-only entries.
   - Track pre-existing dirty/untracked files without reading file content unless backup is needed.

4. Diff algorithm.
   - Compare current stat ledger against checkpoint baseline.
   - Classify:
     - created
     - modified
     - deleted
     - metadata
   - Detect strong renames only when VFS captured `rename`.
   - Treat uncertain rename as delete plus create.

### Acceptance Gates

- Git repo snapshot works.
- Non-Git snapshot works.
- Ignored directories are skipped.
- No file hashing occurs in default path.
- `mtimeMs` and size changes classify as modified.

## Phase 5: Checkpoint Store And MCTS Concurrency

### Objective

Support multiple active checkpoints without manifest collision.

### Implementation Parts

1. Checkpoint model.
   - `id`
   - `parentId`
   - `baseline`
   - `dirty`
   - `storageNamespace`
   - `status`
   - `createdAt`
   - per-checkpoint lock.

2. Concurrent storage.
   - Use `Map<CheckpointId, Checkpoint>`.
   - Never share mutable manifest maps across checkpoints.
   - Each checkpoint gets its own namespace.

3. Capacity policy.
   - Add finite default `maxConcurrentCheckpoints`.
   - On capacity pressure, run aggressive GC.
   - Throw typed capacity error only after GC fails to free room.

4. Parent checkpoint metadata.
   - Allow parent IDs for future MCTS tree reasoning.
   - Do not implement branch merging in this phase.

### Acceptance Gates

- Multiple checkpoints can be active.
- Dirty entry in one checkpoint does not appear in sibling checkpoint.
- Capacity error only occurs after GC attempt.
- Disposed checkpoints are removed from active registry.

## Phase 6: Storage Strategy MVP - Pure Manifest

### Objective

Implement the universal correctness strategy first.

### Implementation Parts

1. Backup file.
   - Copy dirty file content into checkpoint namespace.
   - Preserve enough metadata for restoration.
   - Handle missing source as deleted file.

2. Restore file.
   - Write to same-directory temp file.
   - Flush where practical.
   - Atomic rename over target.
   - Recreate parent directories if file was deleted.

3. Delete created file.
   - Delete only manifest-listed created paths.
   - Never run recursive cleanup outside dirty-set paths.

4. Metadata handling.
   - Restore mode where safe.
   - Do not chmod arbitrary files outside dirty targets.

### Acceptance Gates

- Modified file restores exactly.
- Deleted file is recreated.
- Created file is removed.
- Rollback never touches unrelated file.
- Temp file leftovers are GC-able.

## Phase 7: Atomic Rollback Engine And Ghost Directory Cleaner

### Objective

Make rollback safe under partial failure and clean after scratch-file creation.

### Implementation Parts

1. Rollback order.
   - Acquire checkpoint lock.
   - Mandatory `await reconcile(checkpointId)`.
   - Restore/delete dirty entries.
   - Run ghost directory cleanup.
   - Mark checkpoint disposed or clean.
   - Release lock.

2. Native-binding firewall.
   - `rollback()` must always call `reconcile()` first.
   - This cannot be disabled by public API.
   - It catches writes from `esbuild`, `oxc`, SWC, Python extensions, native npm hooks, and other binaries.

3. Ghost directory cleaner.
   - After deleting created files, reverse-walk parent dirs.
   - Delete empty parent dirs created by agent.
   - Stop at workspace root.
   - Stop at pre-existing baseline dirs.
   - Stop at ignored boundary.
   - Stop at first non-empty dir.

4. Failure behavior.
   - If restore backup is missing, throw integrity error.
   - Do not silently continue after corrupt restore state.

### Acceptance Gates

- Rollback calls reconcile even if caller did not.
- Scratch file directories are removed bottom-up.
- Pre-existing directories survive.
- Partial temp write does not corrupt target.

## Phase 8: Reconciliation Engine

### Objective

Detect mutations from child processes and native tools.

### Implementation Parts

1. Public method.
   - `reconcile(checkpointId?: CheckpointId): Promise<ReconcileResult>`.
   - Default target is most recent active checkpoint.

2. Diff current state.
   - Rerun Hybrid State Engine.
   - Compare to checkpoint baseline.
   - Merge with VFS/track dirty entries.

3. Child-process coverage.
   - `npm install`
   - `pnpm install`
   - `tsc`
   - formatters
   - test snapshots
   - codegen
   - `esbuild`
   - `oxc`
   - SWC
   - Python/native extensions.

4. Merge semantics.
   - Multiple captures of same path collapse to one dirty entry.
   - Reconcile cannot remove an already captured dirty entry unless file has returned exactly to baseline.

### Acceptance Gates

- Child process write is detected.
- Native binary write simulation is detected.
- Reconcile respects default ignores.
- Reconcile result reports created/modified/deleted paths.

## Phase 9: VFS Interceptor

### Objective

Make integration invisible for normal Node-based agents.

### Implementation Parts

1. Patch sync APIs.
   - `writeFileSync`
   - `appendFileSync`
   - `renameSync`
   - `unlinkSync`
   - `rmSync`
   - `mkdirSync`
   - `copyFileSync`
   - `chmodSync`
   - `utimesSync`.

2. Patch callback APIs.
   - Preserve callback semantics.
   - Record before original operation.
   - Propagate original errors.

3. Patch `fs/promises`.
   - Mirror sync/callback coverage.

4. Streams.
   - Wrap `createWriteStream`.
   - Track path at stream creation.

5. Safety.
   - Idempotent install.
   - Idempotent uninstall.
   - Ignore outside root.
   - Ignore configured ignores.

### Acceptance Gates

- Node write auto-registers dirty file.
- Rename records both paths.
- Uninstall restores original functions.
- Interceptor does not alter error behavior.
- Native/child-process blindspot is documented and covered by rollback reconciliation.

## Phase 10: Tier 1 Tmpfs Dirty-Set Strategy

### Objective

Add RAM-backed dirty-set backup for Linux/WSL2.

### Implementation Parts

1. Namespace layout.
   - `/dev/shm/hyperion-delta/<session-id>/<checkpoint-id>/`.

2. Dirty-set only.
   - Do not copy full workspace.
   - Backup only touched paths.
   - Keep metadata small.

3. Fallback.
   - If `/dev/shm` missing or write fails, degrade.
   - If inode/space pressure appears, degrade or throw typed capacity error.

4. Cleanup.
   - Remove tmpfs namespace on checkpoint dispose.
   - Remove stale tmpfs namespace on startup GC.

### Acceptance Gates

- Linux/WSL2 selects tmpfs when available.
- Tmpfs strategy stores only dirty files.
- Cleanup removes namespace.
- Fallback preserves correctness.

## Phase 11: Tier 2 Posix Link Strategy

### Objective

Add hard-link/rsync acceleration for macOS/Linux without EXDEV risk.

### Implementation Parts

1. Same-device validation.
   - Compare `fs.statSync(workspaceRoot).dev` and `fs.statSync(sessionRoot).dev`.
   - Skip Tier 2 if mismatch.

2. Default session root.
   - `.hyperion/checkpoints/` inside project by default.
   - This keeps checkpoint namespace on same physical device.

3. Backup behavior.
   - Hard-link or rsync-link dirty files into checkpoint namespace.
   - Copy-on-write materialize before overwriting link targets where necessary.

4. EXDEV fallback.
   - Catch unexpected `EXDEV`.
   - Mark strategy unsafe for session.
   - Retry operation through Pure Manifest strategy.

### Acceptance Gates

- Same-device path selects Tier 2.
- Cross-device path degrades to Tier 3 before attempting links.
- Unexpected EXDEV does not crash public API.
- Rollback output matches Pure Manifest behavior.

## Phase 12: Lifecycle Hooks And Garbage Collection

### Objective

Prevent zombie sessions, leaked tmpfs entries, and inode exhaustion.

### Implementation Parts

1. Lifecycle hooks.
   - `exit`
   - `SIGINT`
   - `SIGTERM`
   - `SIGHUP`
   - `uncaughtException`
   - `unhandledRejection`.

2. Synchronous emergency cleanup.
   - Never throw.
   - Delete known Hyperion namespaces only.
   - Restore permissions on Hyperion-owned dirs before delete.

3. Startup GC.
   - Remove stale sessions.
   - Remove abandoned temp files.
   - Remove lockfiles whose owner process no longer exists.

4. Capacity GC.
   - Triggered by `snapshot()` before capacity error.
   - Removes disposed checkpoints.
   - Frees inodes in CI/Docker/tmpfs environments.

### Acceptance Gates

- Disposed checkpoint namespaces are removed.
- Startup removes fake stale session.
- `snapshot()` runs GC before capacity error.
- Cleanup never deletes user files.

## Phase 13: Integration Tests And Safety Matrix

### Objective

Prove correctness across real filesystem behaviors.

### Test Categories

1. Pure Node unit tests.
   - path normalization
   - ignore matching
   - manifest diff
   - checkpoint store.

2. Filesystem integration tests.
   - create/modify/delete/rename
   - ghost directories
   - atomic rollback temp files
   - permission edge cases.

3. Git integration tests.
   - tracked file restore
   - untracked file restore
   - ignored file behavior
   - Git unavailable fallback.

4. Child-process tests.
   - write via spawned Node process
   - write via shell redirection
   - simulate native tool output.

5. Strategy tests.
   - Tier 1 when `/dev/shm` available
   - Tier 2 same-device validation
   - Tier 3 Windows-safe behavior.

6. Concurrency tests.
   - multiple active checkpoints
   - sibling dirty isolation
   - capacity GC
   - parallel rollback lock conflict.

### Acceptance Gates

- Tests pass on Windows.
- Tests pass on WSL2/Linux.
- macOS tests are documented if not locally available.
- No test mutates repo root except controlled fixture folders.

## Phase 14: Prettiflow Adapter Layer

### Objective

Provide a clean integration pattern for Prettiflow's agent execution loop.

### Implementation Parts

1. Agent lifecycle wrapper.
   - initialize workspace at CLI startup.
   - install interceptor.
   - snapshot before each attempt.
   - reconcile after child-process calls.
   - rollback on failed attempt.
   - dispose on CLI exit.

2. Diagnostics.
   - expose selected strategy.
   - expose checkpoint count.
   - expose last reconcile result.
   - expose rollback timing.

3. Safe defaults.
   - no mandatory flags.
   - env/debug flag only for diagnostics.

### Acceptance Gates

- Prettiflow loop can use Hyperion with fewer than 10 lines of integration code.
- Child-process mutation is covered by either explicit reconcile or rollback firewall.
- Integration leaves workspace clean after failure.

## Phase 15: Benchmark And Regression Suite

### Objective

Turn current empirical benchmark into a regression benchmark.

### Implementation Parts

1. Keep `benchmark.ts` as a standalone benchmark.
2. Add package-level benchmark command.
3. Add configurable file count and iteration count.
4. Record:
   - Git baseline
   - Pure manifest
   - tmpfs
   - POSIX link.
5. Fail performance regression only in optional benchmark CI, not normal test CI.

### Acceptance Gates

- Benchmark still reproduces 50k/10 evidence shape.
- Small smoke benchmark runs under one minute.
- Benchmark output includes selected strategy and work root.

## Phase 16: Packaging And Release Readiness

### Objective

Prepare SDK for npm and enterprise consumption.

### Implementation Parts

1. Package exports.
   - ESM entry.
   - Types entry.
   - Consider CJS compatibility only if required.

2. Documentation.
   - README SDK quickstart.
   - ARCHITECTURE link.
   - API reference.
   - troubleshooting guide.

3. Release checks.
   - typecheck
   - tests
   - package dry run
   - npm provenance if used.

4. Security posture.
   - no broad shell execution in public API.
   - strategy internals only invoke fixed commands.
   - no user-controlled command construction.

### Acceptance Gates

- `npm pack --dry-run` contains intended files only.
- Package can be installed into a sample project.
- Quickstart example works.

## Cross-Phase Definition Of Done

Every phase is done only when:

- TypeScript compiles.
- Tests for the phase pass.
- Public API behavior remains compatible with `ARCHITECTURE.md`.
- No generated Hyperion sessions remain in the repo.
- No ignored dependency/cache folders are accidentally tracked.
- Failure modes are tested or explicitly documented for the phase.

## Suggested Implementation Order

1. Scaffold.
2. Types and public API.
3. Path and ignore foundation.
4. Environment discovery.
5. Hybrid state engine.
6. Checkpoint store.
7. Pure manifest strategy.
8. Atomic rollback and ghost cleanup.
9. Reconciliation.
10. VFS interceptor.
11. Tmpfs strategy.
12. Posix link strategy.
13. Lifecycle GC.
14. Integration tests.
15. Prettiflow adapter.
16. Packaging.

This order keeps the SDK correct at every milestone and introduces performance accelerators only after rollback correctness is proven.
