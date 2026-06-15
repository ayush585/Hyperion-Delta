# Security

## Supported Posture

Hyperion Delta is currently a local Node.js/TypeScript SDK with zero runtime dependencies. The package is designed to manage local workspace rollback without exposing shell execution to agent code.

Security-relevant constraints:

- Public APIs do not accept or execute arbitrary shell commands.
- Runtime command probes are fixed internal checks only, currently `git --version`, `rsync --version`, and fixed Git metadata reads.
- User-controlled paths are normalized to workspace-relative form before filesystem operations.
- Default ignores exclude dependency and internal state folders such as `node_modules/**`, `.git/**`, and `.hyperion/**`.
- Rollback performs mandatory reconciliation before restore so child-process and native-tool mutations are not silently missed.
- Missing backup records fail loudly instead of attempting partial silent recovery.

## Reporting

Security reporting contact is not finalized yet. Until a private channel is published, report issues through the repository maintainers or GitHub security advisory flow for the project.

Do not include sensitive local workspace contents in public issue reports.
