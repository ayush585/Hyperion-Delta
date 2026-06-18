---
title: Release & Publishing
description:
  How to publish hyperion-delta — local checks, CI pipeline, and
  trusted publishing workflow.
---

## Local pre-publish gate

Before pushing a release:

1. Start from a clean working tree on `main`
2. Install from the lockfile: `npm ci`
3. Run the full release check: `npm run release:final`
4. Run reliability gates: `npm run test:reliability:ci`
5. Review `npm pack --dry-run` — confirm only `dist`, `README.md`,
    `ARCHITECTURE.md`, `LIMITATIONS.md`, `CHANGELOG.md`, `LICENSE`,
    the benchmark hero image, and npm metadata
6. Confirm the package install smoke imports both `HyperionWorkspace` and
    `HyperionAgentSession` from the packed tarball

```sh
npm run release:final
```

This runs typecheck, tests, build, `npm pack --dry-run`, `npm audit --omit=dev`,
and a temp-project install smoke.

## Publishing flow

Publishing is handled by GitHub Actions with npm provenance:

1. Bump the version: `npm version patch`
2. Push the commit and tag:
   ```sh
   git push origin main
   git push origin --tags
   ```
3. Create a GitHub Release for the new version tag
4. CI runs `npm run release:final` and publishes with
    `npm publish --provenance`

Manual dispatch is available as a fallback: run `Publish Package` from
`main` and provide `tag` as `refs/tags/vX.Y.Z`.

The package is published with a signed provenance statement. The
workflow lives at `.github/workflows/publish.yml`.

## Trusted publishing

The CI workflow uses npm trusted publishing with GitHub OIDC (`id-token:
write`). No npm token is required when trusted publishing is configured for:

- Repository: `ayush585/Hyperion-Delta`
- Workflow: `.github/workflows/publish.yml`
- Environment: `npm-publish`

## Current release target

- **Package:** `hyperion-delta`
- **Runtime:** Node.js 20+
- **Runtime dependencies:** none
- **License:** MIT
