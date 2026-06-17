#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:process";

const FILE_COUNT = parseInt(process.env.HYPERION_FILE_COUNT ?? "25000", 10);
const DIRTY_COUNT = parseInt(process.env.HYPERION_DIRTY_COUNT ?? "10", 10);
const ITERATIONS = parseInt(process.env.HYPERION_ITERATIONS ?? "5", 10);

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

function safeRmDir(path) {
  if (existsSync(path)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* retry */ }
  }
}

function timeNs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

// Synthesize
console.error(`Synthesizing ${FILE_COUNT.toLocaleString()} TypeScript files...`);
safeRmDir(WORK_ROOT);
safeRmDir(BASE_DIR);

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
  safeRmDir(WORK_DIR);
  cpSync(BASE_DIR, WORK_DIR, { recursive: true });

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
      safeRmDir(join(WORK_DIR, sp));
    }
    for (const rp of dirtyPaths) {
      const src = join(BASE_DIR, rp);
      const dst = join(WORK_DIR, rp);
      const tmp = dst + ".hyperion_tmp";
      cpSync(src, tmp);
      try { rmSync(dst, { force: true }); } catch {}
      cpSync(tmp, dst);
      safeRmDir(tmp);
    }
  });

  samples.push(rollbackMs);
}

safeRmDir(WORK_ROOT);

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