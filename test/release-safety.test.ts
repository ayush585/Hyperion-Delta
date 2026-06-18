import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

describe("release safety", () => {
  it("keeps the published package file boundary intentional", () => {
    const packageJson = readJson("package.json");

    assert.deepEqual(packageJson.files, [
      "dist",
      "assets/hyperion-benchmark-hero.png",
      "README.md",
      "ARCHITECTURE.md",
      "LIMITATIONS.md",
      "CHANGELOG.md",
      "LICENSE",
    ]);
    assert.equal(packageJson.dependencies, undefined);
    assert.equal(packageJson.type, "module");
    assert.equal(packageJson.exports["."].import, "./dist/index.js");
    assert.equal(packageJson.exports["."].types, "./dist/index.d.ts");
    assert.equal(packageJson.publishConfig.access, "public");
    assert.equal(packageJson.repository.url, "git+https://github.com/ayush585/Hyperion-Delta.git");
    assert.equal(packageJson.bugs.url, "https://github.com/ayush585/Hyperion-Delta/issues");
    assert.equal(packageJson.homepage, "https://github.com/ayush585/Hyperion-Delta#readme");
    assert.equal(packageJson.packageManager, "npm@10.9.2");
    assert.ok(packageJson.keywords.includes("rollback"));
  });

  it("defines release scripts that use repo-local commands only", () => {
    const packageJson = readJson("package.json");
    const scripts = packageJson.scripts;

    assert.equal(scripts.typecheck, "tsc -p tsconfig.test.json --noEmit");
    assert.equal(scripts.test, "npm run build:test && node --test .test-dist/test");
    assert.equal(scripts.build, "tsc -p tsconfig.json");
    assert.equal(scripts["package:smoke"], "node scripts/package-install-smoke.mjs");
    assert.equal(
      scripts["release:check"],
      "npm run typecheck && npm test && npm run build && npm pack --dry-run && npm run package:smoke",
    );
    assert.equal(
      scripts["release:final"],
      "npm run release:check && npm audit --omit=dev && npm pack --dry-run",
    );
  });

  it("keeps CI on the non-publishing release check path", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release-check.yml"), "utf8");

    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /branches:\s*\n\s*- main/);
    assert.match(workflow, /node-version: 20/);
    assert.match(workflow, /run: npm ci/);
    assert.match(workflow, /run: npm run release:check/);
    assert.doesNotMatch(workflow, /npm publish/);
    assert.doesNotMatch(workflow, /--provenance/);
  });

  it("keeps docs deploy workflow cached and docs artifacts ignored", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github/workflows/docs.yml"), "utf8");
    const docsGitignore = readFileSync(path.join(repoRoot, "docs/.gitignore"), "utf8");

    assert.match(workflow, /name:\s*Setup Node/);
    assert.match(workflow, /cache:\s*npm/);
    assert.match(workflow, /cache-dependency-path:\s*docs\/package-lock\.json/);
    assert.match(docsGitignore, /^\*\.log$/m);
    assert.match(docsGitignore, /^\*\.tgz$/m);
  });

  it("keeps reliability workflows cross-platform with nightly soak coverage", () => {
    const reliabilityWorkflow = readFileSync(
      path.join(repoRoot, ".github/workflows/reliability.yml"),
      "utf8",
    );
    const nightlyWorkflow = readFileSync(
      path.join(repoRoot, ".github/workflows/nightly-soak.yml"),
      "utf8",
    );

    assert.match(reliabilityWorkflow, /name:\s*Reliability/);
    assert.match(reliabilityWorkflow, /ubuntu-latest/);
    assert.match(reliabilityWorkflow, /windows-latest/);
    assert.match(reliabilityWorkflow, /macos-latest/);
    assert.match(reliabilityWorkflow, /failure-injection/);
    assert.match(reliabilityWorkflow, /fuzz-smoke/);
    assert.match(reliabilityWorkflow, /stress-smoke/);
    assert.match(reliabilityWorkflow, /repeatability-gate/);
    assert.match(nightlyWorkflow, /name:\s*Nightly Soak/);
    assert.match(nightlyWorkflow, /schedule:/);
    assert.match(nightlyWorkflow, /cron:\s*"0 2 \* \* \*"/);
    assert.match(nightlyWorkflow, /nightly-soak-linux/);
    assert.match(nightlyWorkflow, /nightly-soak-windows/);
    assert.match(nightlyWorkflow, /nightly-soak-macos/);
  });

  it("keeps trusted publishing explicit, tag-scoped, and token-free", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github/workflows/publish.yml"), "utf8");

    assert.match(workflow, /release:/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /description:\s*"Tag ref to publish \(refs\/tags\/vX\.Y\.Z\)"/);
    assert.match(workflow, /required:\s*true/);
    assert.match(workflow, /name:\s*Guard manual publish branch/);
    assert.match(workflow, /if:\s*github\.event_name == 'workflow_dispatch'/);
    assert.match(workflow, /Manual publish workflow_dispatch is allowed only from refs\/heads\/main/);
    assert.match(workflow, /Manual publish requires a semantic version tag ref like refs\/tags\/vX\.Y\.Z/);
    assert.match(workflow, /ref:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.tag \|\| github\.ref \}\}/);
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /contents:\s*read/);
    assert.match(workflow, /environment:\s*npm-publish/);
    assert.match(workflow, /node-version: 20/);
    assert.match(workflow, /run: npm ci/);
    assert.match(workflow, /run: npm run release:final/);
    assert.match(workflow, /run: npm publish --provenance/);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
    assert.doesNotMatch(workflow, /NPM_TOKEN/);
    assert.doesNotMatch(workflow, /\bnpm_[A-Za-z0-9]{32,}\b/);
  });

  it("documents the initial release changelog", () => {
    const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");

    assert.match(changelog, /## 0\.1\.0 - 2026-06-17/);
    assert.match(changelog, /3,478\.407 ms/);
    assert.match(changelog, /Hot Dirty Buffer/);
    assert.match(changelog, /Windows NTFS hard-link/);
    assert.match(changelog, /trusted-publishing workflow/);
  });

  it("keeps runtime child-process usage fixed or explicit-args only", () => {
    const runtimeFiles = listFiles(path.join(repoRoot, "src"), ".ts");
    const childProcessFiles = runtimeFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes("node:child_process");
    });

    assert.deepEqual(
      childProcessFiles.map((file) => path.relative(repoRoot, file).replaceAll(path.sep, "/")).sort(),
      ["src/agent-session.ts", "src/internal/environment.ts", "src/internal/state.ts"],
    );

    for (const file of childProcessFiles) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /\bexecSync\b/);
      assert.doesNotMatch(source, /\bshell:\s*true\b/);
    }

    const agentSessionSource = readFileSync(path.join(repoRoot, "src/agent-session.ts"), "utf8");
    assert.match(agentSessionSource, /\bspawn\b/);
    assert.match(agentSessionSource, /shell:\s*false/);
    assert.doesNotMatch(agentSessionSource, /\bspawnSync\b/);

    const stateSource = readFileSync(path.join(repoRoot, "src/internal/state.ts"), "utf8");
    assert.match(stateSource, /execFileSync\("git"/);

    const environmentSource = readFileSync(path.join(repoRoot, "src/internal/environment.ts"), "utf8");
    assert.match(environmentSource, /command: "git" \| "rsync" \| "fsutil"/);
    assert.match(environmentSource, /adapter\.execFileSync\(command, \["--version"\]\)/);
    assert.match(environmentSource, /adapter\.execFileSync\("fsutil", \["fsinfo", "volumeinfo", volumePath\]\)/);
    assert.match(environmentSource, /adapter\.execFileSync\("fsutil", \["devdrv", "query", volumePath\]\)/);
  });
});

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function listFiles(root: string, extension: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(root, entry);
    const stat = statSync(absolutePath);

    if (stat.isDirectory()) {
      files.push(...listFiles(absolutePath, extension));
      continue;
    }

    if (stat.isFile() && absolutePath.endsWith(extension)) {
      files.push(absolutePath);
    }
  }

  return files;
}
