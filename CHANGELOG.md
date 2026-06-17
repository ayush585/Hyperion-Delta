# Changelog

All notable release changes for `hyperion-delta` are documented here.

## 0.1.5 - 2026-06-17

### Benchmark Sweep Framework

- Added `HYPERION_CONFIG` support: pass a JSON config file to override benchmark parameters.
- Added `HYPERION_DIRTY_COUNT`: vary how many files an agent mutates per rollback cycle.
- Added `HYPERION_OUTPUT=json`: machine-readable benchmark output.
- Added `scripts/sweep-runner.mjs`: orchestrates multi-config benchmark sweeps with JSON + Markdown output.
- Added `scripts/win-bench.mjs`: Windows-native benchmark (no Git dependency) for large-scale NTFS testing.
- Added `HYPERION_MODE=agent-search` and `runAgentSearchRunner()` for MCTS-style stress testing.
- Added `HYPERION_SKIP_LEGACY=true` to run targeted reversion runners without the Git baseline.

### Sweep Evidence

- **Dirty-set sweep** (1,000 files, Windows NTFS): 1 dirty file = 4.325ms, 100 dirty files = 298.908ms. Manifest restore scales linearly (153x→2.9x vs Git).
- **Repo-size sweep** (1K→5K files, Windows NTFS): Manifest restore stays flat at 13-21ms. Git reset balloons from 579ms to 1,887ms (3.3x).
- **Agent-search stress test** (500 files, Windows NTFS): 5 branches × 3 files = 67.8ms. 10 branches × 10 files = 147.3ms. MCTS viable in sub-150ms.
- **Windows-native** (10,000 files, Windows NTFS): 10 dirty files = 62ms avg rollback. 9.2x faster than Git on the same machine. No Git operations on the hot path.

### Docs

- Added sweep results to benchmark section (`/benchmark/results/`).
- Added Windows performance page (`/benchmark/windows/`) with methodology and comparison.
- Docs site now has 18 indexed pages with 1,515 search words across all sections.
- Fixed sitemap crash by pinning `@astrojs/sitemap@3.6.0` for Starlight 0.28 compatibility.
- Fixed docs deploy workflow: `npm install` for cross-platform compat, `github-pages` environment.
- Added OG social preview image, docs badge in repo README, Starlight credits in footer.

## 0.1.0 - 2026-06-17

Initial public release candidate for Hyperion Delta, a zero-runtime-dependency Node.js/TypeScript SDK for dirty-set-scale local agent rollback.

### Benchmark Evidence

- Captures the final audit result: Git rollback averaged `3,478.407 ms`, targeted manifest restore averaged `0.971 ms`, and tmpfs dirty-set restore averaged `0.063 ms`.
- Documents the metadata bottleneck lesson: full-tree clone/delete churns inodes and directory metadata on 50k-file workspaces, while Hyperion scales with the dirty set.

### SDK Runtime

- Added `HyperionWorkspace` and `HyperionAgentSession` public APIs.
- Added checkpoint creation, reconciliation, rollback, promotion, patch export, recovery inspection, and rehydration.
- Added the Autopilot `runAttempt()` flow and explicit-args `exec()` helper for safe agent attempt orchestration.
- Added Node VFS interception for sync, callback, promise, and write-stream mutation APIs.

### Storage And Strategy Tiers

- Added Pure Manifest restore as the universal targeted rollback baseline.
- Added tmpfs dirty-set storage for Linux/WSL2 RAM-backed rollback caches.
- Added POSIX hard-link storage for same-device macOS/Linux workspaces.
- Added bounded Hot Dirty Buffer acceleration for small dirty-file backups.
- Added Windows NTFS hard-link storage with safe workspace-target materialization.
- Added Windows volume diagnostics for NTFS, Dev Drive, and ReFS block-clone candidacy.

### Safety And Recovery

- Added strict ignored-write policy and exact ignored-path tool output contracts.
- Added durable attempt journals, backup manifests, startup stale-session cleanup, capacity cleanup, and emergency lifecycle cleanup.
- Added atomic restore through same-directory temp files plus rename.
- Added ghost-directory cleanup for agent-created empty parent directories.

### Release Readiness

- Added package install smoke checks, release safety tests, package boundary checks, and CI release verification.
- Prepared trusted-publishing workflow support for npm provenance. Actual npm publishing remains a manual maintainer action after npm trusted-publisher configuration.
