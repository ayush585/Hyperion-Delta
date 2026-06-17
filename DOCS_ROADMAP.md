# Hyperion Delta Documentation Site Roadmap

This roadmap builds a public documentation site for `hyperion-delta` using Astro's Starlight framework, deployed to GitHub Pages. Each phase is intentionally narrow — reviewable, testable, and independently shippable.

## Engineering Principles

- Ship a live site before adding content breadth. Phase 0 scaffolds + deploys an empty-but-styled site. Every phase after adds content on top of a working deployment.
- Keep the site build inside a `docs/` folder. The SDK source, tests, and benchmarks are untouched.
- Starlight gives free sidebar navigation, dark mode, search, and mobile layout. Do not fight the framework.
- Content mirrors existing repo docs — don't rewrite, repackage.
- The site must build and deploy on every push to `main` through a dedicated GitHub Actions workflow.

## Phase 0: Astro + Starlight Scaffold

### Objective

Create a minimal Starlight project inside `docs/` that builds and can be deployed.

### Implementation Parts

1. Initialize Astro with the Starlight template:
   - Run `npm create astro@latest docs -- --template starlight --typescript strict --skip-houston`
   - Alternatively, manually scaffold with `@astrojs/starlight`

2. Configure `astro.config.mjs`:
   - `title`: `"Hyperion Delta"`
   - `base`: `"/Hyperion-Delta/"` (for GitHub Pages subpath)
   - `description`: single-line summary
   - Keep default Starlight sidebar for now

3. Install dependencies:
   - `@astrojs/starlight`
   - `astro`
   - TypeScript types

4. Add scripts to `docs/package.json`:
   - `dev` — local dev server
   - `build` — production build
   - `preview` — preview production build

5. Verify `npm run dev` renders the default Starlight home page.

### Acceptance Gates

- `docs/` directory exists with a standalone `package.json`
- `astro dev` starts without errors on `http://localhost:4321`
- `astro build` produces a static `docs/dist/` folder
- SDK source, tests, and benchmark are unchanged

## Phase 1: Site Configuration & Branding

### Objective

Brand the site and configure navigation skeleton before adding real content.

### Implementation Parts

1. Sidebar structure in `astro.config.mjs`:
   - **Getting Started** (landing page + quickstart)
   - **Architecture** (thesis, strategies, safety model)
   - **API Reference** (workspace, agent session, types)
   - **Guides** (limitations, security, troubleshooting, release)
   - **Benchmark** (results, reproduction)

2. Header configuration:
   - GitHub link (`ayush585/Hyperion-Delta`)
   - npm badge or link

3. Custom CSS (`src/styles/custom.css`):
   - Accent color: a deep indigo/purple
   - Hero gradient matching the "frontier lab" aesthetic
   - Dark mode refinements

4. Site assets:
   - SVG favicon (simple geometric "H" or delta symbol)
   - Social preview / OG image (can be a generated gradient with text)

5. Home page metadata:
   - `head` frontmatter with SEO `description` and `title`

### Acceptance Gates

- Sidebar renders categories matching the planned sections
- Custom colors apply in both light and dark mode
- GitHub link appears in the header
- Favicon shows in browser tab

## Phase 2: Landing Page

### Objective

Build the home page with a hero, install snippet, and feature cards.

### Implementation Parts

1. Replace `src/content/docs/index.md` with a landing page:
   - **Hero section**: headline `"Undo agent mistakes in microseconds"`, tagline with the 55,000x benchmark result
   - **Install command**: `npm install hyperion-delta`
   - **5-line code example**: `HyperionAgentSession` quickstart
   - **Call-to-action buttons**: "Get Started" → guides, "GitHub" → repo

2. Feature cards grid:
   - **Dirty-Set Rollback** — scales with what the agent touched
   - **VFS Interception** — zero-config for Node-based agents
   - **Multi-Tier Storage** — tmpfs, POSIX link, NTFS link, pure manifest
   - **Safety Guarantees** — reconcile firewall, atomic restore, integrity checks

3. Use Starlight's built-in card components or custom HTML in Markdown.

### Acceptance Gates

- Home page renders hero, install snippet, code block, and CTA buttons
- Feature cards display in a responsive grid
- Page is readable on mobile

## Phase 3: Getting Started Guide

### Objective

Give a first-time user everything they need to install and run the SDK in under 5 minutes.

### Implementation Parts

1. Create `src/content/docs/guides/getting-started.md`:
   - Prerequisites (Node.js 20+)
   - Installation: `npm install hyperion-delta`
   - First workspace: `new HyperionWorkspace(process.cwd())`
   - First session: `HyperionAgentSession` with `runAttempt()`
   - Promotion: `session.promote(checkpointId)`
   - Cleanup: `session.dispose()`

2. Create `src/content/docs/guides/concepts.md`:
   - Checkpoints — snapshots of workspace state
   - Rollback — undoing dirty-set mutations
   - Reconcile — catching child-process writes
   - Promote — finalizing successful attempts
   - Dispose — cleaning up session state

3. Port the SDK Quickstart section from `README.md`.

### Acceptance Gates

- Getting started page walks through install → first code → cleanup
- Concepts page explains each core operation in one paragraph each
- Code snippets are copy-paste runnable

## Phase 4: Architecture Pages

### Objective

Port `ARCHITECTURE.md` into multiple focused pages with diagrams and strategy comparisons.

### Implementation Parts

1. Create `src/content/docs/architecture/thesis.md`:
   - Why rollback should scale with changed files, not repo size
   - Benchmark evidence summary
   - Metadata bottleneck lesson

2. Create `src/content/docs/architecture/strategies.md`:
   - Strategy tier table (Tier 1–3, NTFS link, Hot Dirty Buffer)
   - When each tier activates
   - Fallback behavior
   - Platform-specific notes

3. Create `src/content/docs/architecture/safety.md`:
   - Reconcile firewall (mandatory before rollback)
   - Atomic restore (temp file + rename)
   - Ghost directory cleanup
   - Integrity errors (missing backup = loud failure)
   - Ignored-write safety (strict mode, tool contracts)

4. Create `src/content/docs/architecture/git-companion.md`:
   - Hyperion owns attempts, Git owns history
   - Durable attempt journals
   - Patch export + promotion
   - Recovery rehydration

### Acceptance Gates

- Four architecture pages exist with content ported from ARCHITECTURE.md
- Strategy tier table is readable
- Cross-links between architecture pages work

## Phase 5: API Reference

### Objective

Provide complete, navigable API documentation for every public export.

### Implementation Parts

1. Create `src/content/docs/api/workspace.md`:
   - `HyperionWorkspace` constructor and config
   - Methods: `snapshot()`, `reconcile()`, `rollback()`, `promote()`, `dispose()`, `track()`, `declareToolOutputs()`, `getDiagnostics()`, `recoverAttempts()`, `rehydrateAttempt()`, `exportPatch()`
   - Install/uninstall interceptor methods

2. Create `src/content/docs/api/agent-session.md`:
   - `HyperionAgentSession` constructor
   - `runAttempt()` with callback signature and options
   - `exec()` and context `exec()`
   - `getDiagnostics()`, `promote()`, `dispose()`

3. Create `src/content/docs/api/types.md`:
   - `HyperionConfig` with every field and default
   - `CheckpointId`, `ReconcileResult`, `StorageStrategyKind`
   - Error classes: `HyperionError`, `HyperionCapacityError`, `HyperionIntegrityError`, `HyperionPathError`, `HyperionRollbackError`

4. Each method should include:
   - Signature with types
   - Description of behavior
   - Example usage
   - Error conditions

### Acceptance Gates

- Every public method appears in the API reference
- Type config shows all options with defaults
- Error classes are documented with when they're thrown

## Phase 6: Guides Section

### Objective

Port the remaining documentation files into the guides section.

### Implementation Parts

1. Create `src/content/docs/guides/limitations.md`:
   - Port `LIMITATIONS.md` content
   - No permanent history or merging
   - Platform disparity / Windows tax
   - Ignored files blindspot
   - Agent lifecycle complexity
   - North Star architecture diagram

2. Create `src/content/docs/guides/security.md`:
   - Port `SECURITY.md` content
   - Supported posture
   - Reporting channels

3. Create `src/content/docs/guides/troubleshooting.md`:
   - Port troubleshooting section from `README.md`
   - Git unavailable
   - tmpfs unavailable
   - `rsync` unavailable
   - Windows / NTFS notes
   - Ignored path behavior
   - Strict ignored writes
   - Child-process modified/deleted files
   - Missing backup records

4. Create `src/content/docs/guides/release.md`:
   - Port `RELEASE.md` content
   - Local pre-publish gate
   - CI trusted publishing flow
   - Current release target

### Acceptance Gates

- All four guide pages exist with content
- Troubleshooting entries are individually scannable
- Release page documents the CI workflow

## Phase 7: Benchmark Evidence

### Objective

Showcase the core performance claim with reproducible evidence.

### Implementation Parts

1. Create `src/content/docs/benchmark/results.md`:
   - Final benchmark table (all four strategies with timings and speedup)
   - Embedded benchmark screenshots
   - What the benchmark measures
   - Metadata bottleneck lesson

2. Create `src/content/docs/benchmark/reproduce.md`:
   - How to run: `npm run benchmark:smoke` and `npm run benchmark`
   - Configuration via environment variables
   - WSL2 notes for Windows users
   - Interpreting results

3. Add benchmark hero image to `docs/src/assets/` for the results page.

### Acceptance Gates

- Results page shows the 54,851.92x headline with the full table
- Reproduce page lets someone clone and run benchmarks
- Screenshots render correctly

## Phase 8: Deployment Pipeline

### Objective

Build and deploy the Starlight site to GitHub Pages on every push to `main`.

### Implementation Parts

1. Create `.github/workflows/docs.yml`:
   - Trigger: push to `main` (paths: `docs/**`)
   - Steps: checkout → setup Node → `npm ci` in `docs/` → `npm run build` → upload artifact → deploy to Pages
   - Permissions: `contents: read`, `pages: write`, `id-token: write`

2. Configure GitHub Pages in repo settings:
   - Source: GitHub Actions
   - Branch: `gh-pages` (managed by the deploy action)

3. Verify `astro.config.mjs` `base` is `"/Hyperion-Delta/"`.

4. Verify the site is reachable at `https://ayush585.github.io/Hyperion-Delta/`.

### Acceptance Gates

- Push to `main` triggers the docs workflow
- Site deploys to GitHub Pages without manual steps
- All pages render at the expected URLs
- No broken links or missing assets

## Phase 9: Polish

### Objective

Make the site feel finished.

### Implementation Parts

1. SEO:
   - Meta descriptions on every page (`description` frontmatter)
   - Canonical URLs
   - Page titles that read well in search results

2. Social previews:
   - Generate or design an OG image (gradient + "Hyperion Delta" + "55,000x faster rollback")
   - Add `og:image` to the home page and key content pages

3. Mobile check:
   - Hero section doesn't clip
   - Code blocks scroll horizontally
   - Sidebar closes properly
   - Feature cards stack vertically

4. Cross-link audit:
   - No broken internal links
   - External links to GitHub / npm open in new tabs
   - README.md links to the docs site

5. Footer:
   - License: MIT
   - Links: GitHub, npm, Starlight
   - "Built for AI coding agents"

### Acceptance Gates

- Every page has a unique, descriptive title and meta description
- Site is fully usable on a phone screen
- README.md includes a link to the docs site
- No dead links

## Cross-Phase Definition of Done

Every phase is done only when:

- `astro build` exits zero
- The deployed site renders the phase's content correctly
- No SDK source, test, or benchmark files are modified
- The `docs/` directory is self-contained (except for the deployment workflow)
- Links between pages work

## Suggested Implementation Order

1. Scaffold (Phase 0)
2. Config & branding (Phase 1)
3. Landing page (Phase 2)
4. Getting started (Phase 3)
5. Deployment (Phase 8 — deploy early, iterate)
6. Architecture (Phase 4)
7. API reference (Phase 5)
8. Guides (Phase 6)
9. Benchmark (Phase 7)
10. Polish (Phase 9)

Phase 8 is moved up so every content phase ships to a live URL immediately. No content phase should merge without being deployable.