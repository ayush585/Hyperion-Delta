# Next Release Checklist

Copy this file for each release cycle and replace placeholders.

## Metadata

- Version: `vX.Y.Z`
- Date: `YYYY-MM-DD`
- Release type: `patch | minor | major`

## 1) Preflight

- [ ] Working tree is clean on `main`
- [ ] Node/npm versions are expected for this repo
- [ ] npm trusted publisher is configured for:
  - owner: `ayush585`
  - repo: `Hyperion-Delta`
  - workflow: `.github/workflows/publish.yml`
  - environment: `npm-publish`

## 2) Version + notes

- [ ] Update `package.json` version
- [ ] Update `package-lock.json` version
- [ ] Update `CHANGELOG.md` with `vX.Y.Z`
- [ ] Update any version constants/docs (for example `RELEASE.md` target)

## 3) Local validation

```sh
npm ci
npm run release:final
npm run test:reliability:ci
npm --prefix docs run build
```

- [ ] All commands pass
- [ ] `npm pack --dry-run` contents are expected

## 4) Commit + tag + push

```sh
git add -A
git commit -m "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

- [ ] Commit pushed
- [ ] Tag pushed

## 5) Publish

- [ ] Create GitHub Release for `vX.Y.Z`
  - This should trigger `.github/workflows/publish.yml`
- [ ] (Fallback) Manual dispatch `Publish Package` from `main` with:
  - `tag=refs/tags/vX.Y.Z`

## 6) Post-release verification

```sh
npm view hyperion-delta version
npm view hyperion-delta time --json
```

- [ ] npm shows `vX.Y.Z`
- [ ] GitHub publish workflow is green
- [ ] Provenance/attestation present on npm package page
- [ ] Fresh install smoke passes in temp project:

```sh
mkdir temp-release-smoke && cd temp-release-smoke
npm init -y
npm i hyperion-delta@X.Y.Z
```

## 7) Announce

- [ ] Publish release notes post
- [ ] Share npm + GitHub release links
