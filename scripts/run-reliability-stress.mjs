import { execFileSync } from "node:child_process";

function readPositiveInteger(name, fallback) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function assertThreshold(name, actual, minimum) {
  if (actual < minimum) {
    throw new Error(`${name} must be >= ${minimum}, received ${actual}`);
  }
}

const stressCycles = readPositiveInteger("HYPERION_STRESS_CYCLES", 120);
const stressConcurrency = readPositiveInteger("HYPERION_STRESS_CONCURRENCY", 6);
const branchStressCycles = readPositiveInteger("HYPERION_BRANCH_STRESS_CYCLES", 20);
const branchSubagents = readPositiveInteger("HYPERION_BRANCH_SUBAGENTS", 4);

assertThreshold(
  "HYPERION_STRESS_CYCLES",
  stressCycles,
  readPositiveInteger("HYPERION_STRESS_MIN_CYCLES", 1),
);
assertThreshold(
  "HYPERION_STRESS_CONCURRENCY",
  stressConcurrency,
  readPositiveInteger("HYPERION_STRESS_MIN_CONCURRENCY", 1),
);
assertThreshold(
  "HYPERION_BRANCH_STRESS_CYCLES",
  branchStressCycles,
  readPositiveInteger("HYPERION_BRANCH_STRESS_MIN_CYCLES", 1),
);
assertThreshold(
  "HYPERION_BRANCH_SUBAGENTS",
  branchSubagents,
  readPositiveInteger("HYPERION_BRANCH_STRESS_MIN_SUBAGENTS", 2),
);

console.log(
  "Running reliability stress:" +
    ` cycles=${stressCycles}, concurrency=${stressConcurrency},` +
    ` branchCycles=${branchStressCycles}, branchSubagents=${branchSubagents}`,
);

execFileSync(
  process.execPath,
  ["--test", ".test-dist/test/workspace-snapshot-reconcile-rollback-stress.test.js"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HYPERION_STRESS_CYCLES: String(stressCycles),
      HYPERION_STRESS_CONCURRENCY: String(stressConcurrency),
    },
  },
);

execFileSync(
  process.execPath,
  ["--test", ".test-dist/test/workspace-branch-contention-stress.test.js"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HYPERION_BRANCH_STRESS_CYCLES: String(branchStressCycles),
      HYPERION_BRANCH_SUBAGENTS: String(branchSubagents),
    },
  },
);
