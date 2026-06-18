#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:process";

const FILE_COUNT = parseInt(process.env.HYPERION_FILE_COUNT ?? "25000", 10);
const DIRTY_COUNT = parseInt(process.env.HYPERION_DIRTY_COUNT ?? "10", 10);
const ITERATIONS = parseInt(process.env.HYPERION_ITERATIONS ?? "5", 10);
const CLEANUP_ATTEMPTS = Math.max(parseInt(process.env.HYPERION_CLEANUP_ATTEMPTS ?? "5", 10) || 5, 1);
const CLEANUP_RETRY_DELAY_MS = Math.max(parseInt(process.env.HYPERION_CLEANUP_RETRY_DELAY_MS ?? "50", 10) || 50, 0);

const WORK_ROOT = join(process.env.HYPERION_WORK_ROOT ?? process.cwd(), ".hyperion_win_bench");
const BASE_DIR = join(WORK_ROOT, "base");
const WORK_DIR = join(WORK_ROOT, "work");

function relativePathFor(index) {
  const parts = [];
  for (let d = 0; d < 8; d += 1) {
    parts.push(`layer_${d}_${Math.floor(index / (d + 1)) % 97}`);
  }
  return join(...parts, `module_${index}.ts`);
}

function filePathFor(index, root) {
  return join(root, relativePathFor(index));
}

function bestEffortRm(path) {
  if (existsSync(path)) {
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
}

function waitMs(ms) {
  if (ms <= 0) {
    return;
  }

  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function formatErrorCodeAndMessage(error) {
  if (error && typeof error === "object") {
    const code = typeof error.code === "string" ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    return `${code}:${message}`;
  }

  return "UNKNOWN:path still exists after cleanup retries";
}

function cleanupWithRetries(path, attempts = CLEANUP_ATTEMPTS) {
  const totalAttempts = Math.max(attempts, 1);
  let firstError = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }

    if (!existsSync(path)) {
      return;
    }

    if (attempt < totalAttempts) {
      waitMs(CLEANUP_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Cleanup failed after retries: path=${path} attempts=${totalAttempts} originalError=${formatErrorCodeAndMessage(firstError)}`,
  );
}

function timeNs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

// Synthesize
console.error(`Synthesizing ${FILE_COUNT.toLocaleString()} TypeScript files...`);
cleanupWithRetries(WORK_ROOT);
cleanupWithRetries(BASE_DIR);

const synthMs = timeNs(() => {
  for (let i = 0; i < FILE_COUNT; i++) {
    const fp = filePathFor(i, BASE_DIR);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, `export const m${i}=${i};export function v${i}():number{return m${i};}\n`);
  }
});
console.error(`Synthesis: ${synthMs.toFixed(0)}ms`);

// Run Hyperion manifest rollback loops
const samples = [];
for (let iter = 0; iter < ITERATIONS; iter++) {
  const iterationNumber = iter + 1;

  cleanupWithRetries(WORK_DIR);
  if (existsSync(WORK_DIR)) {
    throw new Error(
      `Cleanup verification failed: path=${WORK_DIR} attempts=${CLEANUP_ATTEMPTS} originalError=UNKNOWN:work directory still exists`,
    );
  }

  try {
    cpSync(BASE_DIR, WORK_DIR, { recursive: true });
  } catch (error) {
    throw new Error(
      `Workspace copy failed: iteration=${iterationNumber} from=${BASE_DIR} to=${WORK_DIR} originalError=${formatErrorCodeAndMessage(error)}`,
    );
  }

  const dirtyPaths = [];
  const scratchPaths = [];

  for (let d = 0; d < DIRTY_COUNT; d++) {
    const idx = (FILE_COUNT - 1 - ((iter * DIRTY_COUNT + d) % 997)) % FILE_COUNT;
    const rp = relativePathFor(idx);
    dirtyPaths.push(rp);
    writeFileSync(join(WORK_DIR, rp), `export const broken_${iter}_${d}=${iter};\n`);
    const sp = join("scratch", `agent_${iter}_${d}.tmp`);
    scratchPaths.push(sp);
    mkdirSync(dirname(join(WORK_DIR, sp)), { recursive: true });
    writeFileSync(join(WORK_DIR, sp), `scratch ${iter} ${d}\n`);
  }

  const rollbackMs = timeNs(() => {
    for (const sp of scratchPaths) {
      bestEffortRm(join(WORK_DIR, sp));
    }
    for (const rp of dirtyPaths) {
      const src = join(BASE_DIR, rp);
      const dst = join(WORK_DIR, rp);
      const tmp = dst + ".hyperion_tmp";
      cpSync(src, tmp);
      try { rmSync(dst, { force: true }); } catch {}
      cpSync(tmp, dst);
      bestEffortRm(tmp);
    }
  });

  samples.push(rollbackMs);
}

cleanupWithRetries(WORK_ROOT);

const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
const result = {
  platform,
  fileCount: FILE_COUNT,
  dirtyCount: DIRTY_COUNT,
  iterations: ITERATIONS,
  synthesisMs: synthMs,
  samples,
  avgMs: avg,
};

console.log(JSON.stringify(result));
