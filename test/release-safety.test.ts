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
    ]);
    assert.equal(packageJson.dependencies, undefined);
    assert.equal(packageJson.type, "module");
    assert.equal(packageJson.exports["."].import, "./dist/index.js");
    assert.equal(packageJson.exports["."].types, "./dist/index.d.ts");
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

  it("limits runtime child-process usage to fixed internal probes", () => {
    const runtimeFiles = listFiles(path.join(repoRoot, "src"), ".ts");
    const childProcessFiles = runtimeFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes("node:child_process");
    });

    assert.deepEqual(
      childProcessFiles.map((file) => path.relative(repoRoot, file).replaceAll(path.sep, "/")).sort(),
      ["src/internal/environment.ts", "src/internal/state.ts"],
    );

    for (const file of childProcessFiles) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /\bexecSync\b/);
      assert.doesNotMatch(source, /\bspawn(?:Sync)?\b/);
      assert.match(source, /\bexecFileSync\b/);
    }

    const stateSource = readFileSync(path.join(repoRoot, "src/internal/state.ts"), "utf8");
    assert.match(stateSource, /execFileSync\("git"/);

    const environmentSource = readFileSync(path.join(repoRoot, "src/internal/environment.ts"), "utf8");
    assert.match(environmentSource, /command: "git" \| "rsync"/);
    assert.match(environmentSource, /adapter\.execFileSync\(command, \["--version"\]\)/);
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
