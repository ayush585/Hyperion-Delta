#!/usr/bin/env node
// Runs the compiled test suite with an explicit file list. `node --test <dir>`
// only discovers tests on Node 20, and shell globs are not portable to Windows.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, ".test-dist", "test");

let testFiles;

try {
  testFiles = readdirSync(testDir)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join(testDir, name));
} catch (error) {
  console.error(`Cannot read ${testDir}: ${error.message}. Run \`npm run build:test\` first.`);
  process.exit(1);
}

if (testFiles.length === 0) {
  console.error(`No *.test.js files found in ${testDir}.`);
  process.exit(1);
}

// Extra CLI flags (for example --watch) are forwarded to node --test.
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...testFiles], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to start node --test: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  console.error(`node --test terminated by ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
