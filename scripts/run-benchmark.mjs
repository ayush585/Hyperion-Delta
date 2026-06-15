#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const mode = process.argv[2] ?? "full";

if (mode !== "full" && mode !== "smoke") {
  console.error(`Unknown benchmark mode: ${mode}`);
  console.error("Usage: node scripts/run-benchmark.mjs [full|smoke]");
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const tempRoot = mkdtempSync(join(tmpdir(), `hyperion-benchmark-${mode}-`));
const compiledBenchmarkPath = join(tempRoot, "benchmark.cjs");

try {
  const source = readFileSync(join(repoRoot, "benchmark.ts"), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "benchmark.ts",
  });

  writeFileSync(compiledBenchmarkPath, transpiled.outputText);

  const env = {
    ...process.env,
    ...(mode === "smoke"
      ? {
          HYPERION_DIRECTORY_DEPTH: process.env.HYPERION_DIRECTORY_DEPTH ?? "4",
          HYPERION_FILE_COUNT: process.env.HYPERION_FILE_COUNT ?? "200",
          HYPERION_ITERATIONS: process.env.HYPERION_ITERATIONS ?? "3",
          HYPERION_WORK_ROOT: process.env.HYPERION_WORK_ROOT ?? join(tempRoot, "work"),
        }
      : {}),
  };

  const result = spawnSync(process.execPath, [compiledBenchmarkPath], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });

  if (result.signal) {
    console.error(`Benchmark terminated by signal: ${result.signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
