# Release Checklist

Hyperion Delta is prepared for npm trusted publishing with provenance, but this repository cannot publish until npm-side trusted publisher settings are configured by a package maintainer.

## Local Pre-Publish Gate

1. Start from a clean working tree on `main`.
2. Install from the lockfile with `npm ci`.
3. Run `npm run release:final`.
4. Review `npm pack --dry-run`.
5. Confirm the tarball only includes `dist`, `README.md`, `ARCHITECTURE.md`, `LIMITATIONS.md`, `CHANGELOG.md`, the README benchmark hero image, and npm metadata.
6. Confirm the package install smoke imports both `HyperionWorkspace` and `HyperionAgentSession` from the packed tarball.

## Trusted Publishing Setup

Configure npm trusted publishing for `hyperion-delta` before the first publish:

- Publisher: GitHub Actions.
- Repository: `ayush585/Hyperion-Delta`.
- Workflow file: `.github/workflows/publish.yml`.
- Environment: `npm-publish`.
- Package access: public.

The workflow uses OIDC with `id-token: write` and `contents: read`. Do not add npm tokens to the repository.

## Publishing Flow

1. Confirm your npm account can publish `hyperion-delta`.
2. License: MIT. See [LICENSE](./LICENSE).
3. Create a GitHub release for the version or manually dispatch the `Publish Package` workflow.
4. Let CI run `npm run release:final`.
5. The workflow publishes with `npm publish --provenance --access public`.
6. Verify the npm package page, install from a fresh temp project, and check provenance/attestation metadata.

## Current Release Target

- Package: `hyperion-delta`
- Version: `0.1.0`
- Runtime: Node.js 20+
- Runtime dependencies: none
