import { execFileSync } from "node:child_process";

function readPositiveInteger(name, fallback) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const iterations = readPositiveInteger("HYPERION_REPEATABILITY_ITERATIONS", 3);
const tests = [
  ".test-dist/test/error-boundary.test.js",
  ".test-dist/test/workspace-failure-injection.test.js",
  ".test-dist/test/reconciliation-engine-fuzz.test.js",
  ".test-dist/test/rollback-engine-failure-injection.test.js",
];

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  console.log(`Repeatability run ${iteration}/${iterations}`);
  execFileSync(process.execPath, ["--test", ...tests], { stdio: "inherit", env: process.env });
}

console.log(`Repeatability gate passed (${iterations} runs)`);
