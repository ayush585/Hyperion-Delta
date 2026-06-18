import { execFileSync } from "node:child_process";

function readPositiveInteger(name, fallback) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const env = {
  ...process.env,
  HYPERION_FUZZ_SEEDS: String(readPositiveInteger("HYPERION_FUZZ_SEEDS", 200)),
  HYPERION_FUZZ_OPS: String(readPositiveInteger("HYPERION_FUZZ_OPS", 300)),
  HYPERION_RECONCILE_FUZZ_SEEDS: String(readPositiveInteger("HYPERION_RECONCILE_FUZZ_SEEDS", 200)),
  HYPERION_RECONCILE_FUZZ_ENTRIES: String(readPositiveInteger("HYPERION_RECONCILE_FUZZ_ENTRIES", 300)),
  HYPERION_STRESS_CYCLES: String(readPositiveInteger("HYPERION_STRESS_CYCLES", 1500)),
  HYPERION_STRESS_CONCURRENCY: String(readPositiveInteger("HYPERION_STRESS_CONCURRENCY", 8)),
  HYPERION_BRANCH_STRESS_CYCLES: String(readPositiveInteger("HYPERION_BRANCH_STRESS_CYCLES", 240)),
  HYPERION_BRANCH_SUBAGENTS: String(readPositiveInteger("HYPERION_BRANCH_SUBAGENTS", 8)),
  HYPERION_FUZZ_MIN_SEEDS: String(readPositiveInteger("HYPERION_FUZZ_MIN_SEEDS", 200)),
  HYPERION_FUZZ_MIN_OPS: String(readPositiveInteger("HYPERION_FUZZ_MIN_OPS", 300)),
  HYPERION_RECONCILE_FUZZ_MIN_SEEDS: String(readPositiveInteger("HYPERION_RECONCILE_FUZZ_MIN_SEEDS", 200)),
  HYPERION_RECONCILE_FUZZ_MIN_ENTRIES: String(readPositiveInteger("HYPERION_RECONCILE_FUZZ_MIN_ENTRIES", 300)),
  HYPERION_STRESS_MIN_CYCLES: String(readPositiveInteger("HYPERION_STRESS_MIN_CYCLES", 1500)),
  HYPERION_STRESS_MIN_CONCURRENCY: String(readPositiveInteger("HYPERION_STRESS_MIN_CONCURRENCY", 8)),
  HYPERION_BRANCH_STRESS_MIN_CYCLES: String(readPositiveInteger("HYPERION_BRANCH_STRESS_MIN_CYCLES", 240)),
  HYPERION_BRANCH_STRESS_MIN_SUBAGENTS: String(readPositiveInteger("HYPERION_BRANCH_STRESS_MIN_SUBAGENTS", 8)),
};

console.log("Running nightly reliability soak with configured thresholds...");

execFileSync(process.execPath, ["scripts/check-reliability-thresholds.mjs"], {
  stdio: "inherit",
  env,
});

execFileSync(process.execPath, ["scripts/run-reliability-fuzz.mjs"], {
  stdio: "inherit",
  env,
});

execFileSync(process.execPath, ["scripts/run-reliability-stress.mjs"], {
  stdio: "inherit",
  env,
});

console.log("Nightly reliability soak completed successfully.");
