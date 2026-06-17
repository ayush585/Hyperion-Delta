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
4. Review `npm pack --dry-run` — confirm only `dist`, `README.md`,
   `ARCHITECTURE.md`, `LIMITATIONS.md`, `CHANGELOG.md`, `LICENSE`,
   the benchmark hero image, and npm metadata
5. Confirm the package install smoke imports both `HyperionWorkspace` and
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

The package is published with a signed provenance statement. The
workflow lives at `.github/workflows/publish.yml`.

## Trusted publishing

The CI workflow authenticates via an npm granular access token stored as
the `NPM_TOKEN` secret in the `npm-publish` GitHub environment. The token
must have read/write package access and bypass-2FA enabled.

To rotate the token:
1. Generate a new granular access token on
   [npm](https://www.npmjs.com/settings/ayush585/tokens)
2. Update the `NPM_TOKEN` secret in the `npm-publish` environment

## Current release target

- **Package:** `hyperion-delta`
- **Runtime:** Node.js 20+
- **Runtime dependencies:** none
- **License:** MIT