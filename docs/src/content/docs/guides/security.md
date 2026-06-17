---
title: Security
description:
  Security posture and reporting for hyperion-delta.
---

## Supported posture

Hyperion Delta is a local Node.js/TypeScript SDK with **zero runtime
dependencies**. It manages local workspace rollback without exposing
shell execution to agent code.

### Constraints

- Public APIs do **not** accept or execute arbitrary shell command
  strings.
- `HyperionAgentSession.exec()` wraps `child_process.spawn()` with an
  explicit executable path and argument array. It uses `shell: false` by
  default and exists to guarantee reconciliation around external tools —
  it is **not** a security sandbox.
- Runtime command probes are fixed internal checks only:
  `git --version`, `rsync --version`, `fsutil fsinfo volumeinfo`,
  `fsutil devdrv query`, and fixed Git metadata reads.
- User-controlled paths are normalized to workspace-relative form before
  filesystem operations.
- Default ignores exclude dependency and internal state folders:
  `node_modules/**`, `.git/**`, `.hyperion/**`, and others.
- `rollback()` performs mandatory reconciliation before restore so
  child-process and native-tool mutations are not silently missed.
- Missing backup records fail loudly instead of attempting partial silent
  recovery.

## Reporting

Security reporting contact is not finalized yet. Until a private channel
is published, report issues through the repository maintainers or the
GitHub security advisory flow for the project.

Do **not** include sensitive local workspace contents in public issue
reports.