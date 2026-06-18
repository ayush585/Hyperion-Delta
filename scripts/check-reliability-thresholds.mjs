function readPositiveInteger(name, fallback) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const checks = [
  {
    actualName: "HYPERION_FUZZ_SEEDS",
    minimumName: "HYPERION_FUZZ_MIN_SEEDS",
    defaultActual: 10,
    defaultMinimum: 1,
  },
  {
    actualName: "HYPERION_FUZZ_OPS",
    minimumName: "HYPERION_FUZZ_MIN_OPS",
    defaultActual: 80,
    defaultMinimum: 1,
  },
  {
    actualName: "HYPERION_RECONCILE_FUZZ_SEEDS",
    minimumName: "HYPERION_RECONCILE_FUZZ_MIN_SEEDS",
    defaultActual: 10,
    defaultMinimum: 1,
  },
  {
    actualName: "HYPERION_RECONCILE_FUZZ_ENTRIES",
    minimumName: "HYPERION_RECONCILE_FUZZ_MIN_ENTRIES",
    defaultActual: 80,
    defaultMinimum: 1,
  },
  {
    actualName: "HYPERION_STRESS_CYCLES",
    minimumName: "HYPERION_STRESS_MIN_CYCLES",
    defaultActual: 120,
    defaultMinimum: 1,
  },
  {
    actualName: "HYPERION_STRESS_CONCURRENCY",
    minimumName: "HYPERION_STRESS_MIN_CONCURRENCY",
    defaultActual: 6,
    defaultMinimum: 1,
  },
];

for (const check of checks) {
  const actual = readPositiveInteger(check.actualName, check.defaultActual);
  const minimum = readPositiveInteger(check.minimumName, check.defaultMinimum);

  if (actual < minimum) {
    throw new Error(`${check.actualName} must be >= ${minimum}, received ${actual}`);
  }

  console.log(`${check.actualName}=${actual} (minimum ${minimum})`);
}
