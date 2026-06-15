# Release Checklist

Hyperion Delta is not configured for automated npm publishing yet. Releases are manual until provenance and maintainer credentials are intentionally added.

Before publishing:

1. Start from a clean working tree on `main`.
2. Install from the lockfile with `npm ci`.
3. Run `npm run release:check`.
4. Review `npm pack --dry-run` and confirm the tarball only includes `dist`, `README.md`, `ARCHITECTURE.md`, `LIMITATIONS.md`, the README benchmark hero image, and npm metadata.
5. Confirm the package install smoke imports both `HyperionWorkspace` and `HyperionAgentSession` from the packed tarball.

Publishing is deferred. When the team is ready, use a manual `npm publish` flow or add a dedicated provenance-backed GitHub Actions release workflow in a separate phase.
