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

const fuzzSeeds = readPositiveInteger("HYPERION_FUZZ_SEEDS", 10);
const fuzzOps = readPositiveInteger("HYPERION_FUZZ_OPS", 80);
const reconcileFuzzSeeds = readPositiveInteger("HYPERION_RECONCILE_FUZZ_SEEDS", fuzzSeeds);
const reconcileFuzzEntries = readPositiveInteger("HYPERION_RECONCILE_FUZZ_ENTRIES", 80);

assertThreshold(
  "HYPERION_FUZZ_SEEDS",
  fuzzSeeds,
  readPositiveInteger("HYPERION_FUZZ_MIN_SEEDS", 1),
);
assertThreshold(
  "HYPERION_FUZZ_OPS",
  fuzzOps,
  readPositiveInteger("HYPERION_FUZZ_MIN_OPS", 1),
);
assertThreshold(
  "HYPERION_RECONCILE_FUZZ_SEEDS",
  reconcileFuzzSeeds,
  readPositiveInteger("HYPERION_RECONCILE_FUZZ_MIN_SEEDS", 1),
);
assertThreshold(
  "HYPERION_RECONCILE_FUZZ_ENTRIES",
  reconcileFuzzEntries,
  readPositiveInteger("HYPERION_RECONCILE_FUZZ_MIN_ENTRIES", 1),
);

console.log(
  `Running reliability fuzz: seeds=${fuzzSeeds}, ops=${fuzzOps}, reconcileSeeds=${reconcileFuzzSeeds}, reconcileEntries=${reconcileFuzzEntries}`,
);

execFileSync(
  process.execPath,
  [
    "--test",
    ".test-dist/test/vfs-interceptor-fuzz.test.js",
    ".test-dist/test/reconciliation-engine-fuzz.test.js",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HYPERION_FUZZ_SEEDS: String(fuzzSeeds),
      HYPERION_FUZZ_OPS: String(fuzzOps),
      HYPERION_RECONCILE_FUZZ_SEEDS: String(reconcileFuzzSeeds),
      HYPERION_RECONCILE_FUZZ_ENTRIES: String(reconcileFuzzEntries),
    },
  },
);
