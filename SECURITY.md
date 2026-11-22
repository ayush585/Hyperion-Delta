# Security

## Supported Posture

Hyperion Delta is currently a local Node.js/TypeScript SDK with zero runtime dependencies. The package is designed to manage local workspace rollback without exposing shell execution to agent code.

Security-relevant constraints:

- Public APIs do not accept or execute arbitrary shell command strings.
- `HyperionAgentSession.exec()` is a convenience wrapper around an explicit executable plus argument array. It uses `shell: false` by default and exists to guarantee reconciliation around external tools; it is not a security sandbox.
- Runtime command probes are fixed internal checks only, currently `git --version`, `rsync --version`, and fixed Git metadata reads.
- User-controlled paths are normalized to workspace-relative form before filesystem operations.
- Default ignores exclude dependency and internal state folders such as `node_modules/**`, `.git/**`, and `.hyperion/**`.
- Rollback performs mandatory reconciliation before restore so child-process and native-tool mutations are not silently missed.
- Missing backup records are detected before rollback mutates the workspace and fail with a typed integrity error.
- Rollback is not a transaction. A backup file lost from checkpoint storage, or a filesystem error during restore, can leave the workspace partially restored. The error is still raised and the checkpoint stays active for retry.
- VFS interception is not a security boundary. Child processes, native code, and ESM named imports of `fs` bypass it.

## Reporting

Security reporting contact is not finalized yet. Until a private channel is published, report issues through the repository maintainers or GitHub security advisory flow for the project.

Do not include sensitive local workspace contents in public issue reports.
