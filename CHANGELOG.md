# Changelog

All notable release changes for `@prettiflow/hyperion-delta` are documented here.

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
