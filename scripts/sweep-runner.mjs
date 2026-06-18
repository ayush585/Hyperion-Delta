#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node scripts/sweep-runner.mjs <config.json>");
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const configAbs = resolve(configPath);

let sweepConfigs;
try {
  sweepConfigs = JSON.parse(readFileSync(configAbs, "utf8"));
} catch (err) {
  console.error(`Failed to read sweep config: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(sweepConfigs) || sweepConfigs.length === 0) {
  console.error("Sweep config must be a non-empty array");
  process.exit(1);
}

const sweepName = basename(configAbs, ".json");

const benchmarkSource = readFileSync(join(repoRoot, "benchmark.ts"), "utf8");
const transpiled = ts.transpileModule(benchmarkSource, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "benchmark.ts",
});

const benchmarkCode = transpiled.outputText;

const resultsDir = join(repoRoot, "benchmark", "results");
mkdirSync(resultsDir, { recursive: true });

const allResults = [];
const total = sweepConfigs.length;
let succeededCount = 0;

for (let i = 0; i < total; i++) {
  const config = sweepConfigs[i];
  const dirtyCount = config.HYPERION_DIRTY_COUNT ?? 1;
  const fileCount = config.HYPERION_FILE_COUNT ?? 10000;
  const iterations = config.HYPERION_ITERATIONS ?? 20;

  const tempDir = mkdtempSync(join(tmpdir(), "hyperion-sweep-"));
  try {
    const benchFile = join(tempDir, "benchmark.cjs");
    writeFileSync(benchFile, benchmarkCode);

    const tempConfigPath = join(tempDir, "config.json");
    writeFileSync(tempConfigPath, JSON.stringify(config));

    const env = {
      ...process.env,
      HYPERION_OUTPUT: "json",
      HYPERION_CONFIG: tempConfigPath,
      HYPERION_WORK_ROOT: join(tempDir, "work"),
    };

    const child = spawnSync(process.execPath, [benchFile], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });

    if (child.status !== 0 || child.error) {
      const reason = child.error?.message ?? child.stderr?.trim() ?? `exit code ${child.status}`;
      console.error(
        `[${i + 1}/${total}] dirty-count=${dirtyCount} files=${fileCount} iters=${iterations} ... ERROR (${reason})`,
      );
      allResults.push({ config, error: reason });
      continue;
    }

    let parsed;
    try {
      parsed = parseBenchmarkJsonOutput(child.stdout ?? "");
    } catch (err) {
      console.error(
        `[${i + 1}/${total}] dirty-count=${dirtyCount} files=${fileCount} iters=${iterations} ... ERROR (${err.message})`,
      );
      allResults.push({ config, error: err.message });
      continue;
    }

    const manifestRunner = findRunner(parsed.runners, "manifest");
    const searchRunner = findRunner(parsed.runners, "agent");
    const avgLabel =
      manifestRunner && !manifestRunner.skipped
        ? `${manifestRunner.avgMs.toFixed(3)}ms avg`
        : searchRunner && !searchRunner.skipped
          ? `${searchRunner.avgMs.toFixed(3)}ms avg`
          : "skipped";
    console.error(
      `[${i + 1}/${total}] dirty-count=${dirtyCount} files=${fileCount} iters=${iterations} ... done (${avgLabel})`,
    );

    succeededCount += 1;
    allResults.push({ config, data: parsed });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const timestamp = Date.now();
writeResultFiles(repoRoot, sweepName, timestamp, allResults);

console.error(`\nSweep complete: ${succeededCount}/${total} runs succeeded.`);

function writeResultFiles(repoRoot, sweepName, timestamp, results) {
  const resultsDir = join(repoRoot, "benchmark", "results");
  const date = new Date(timestamp).toISOString().slice(0, 10);
  const baseName = `${sweepName}-${timestamp}`;
  const platform = process.platform;

  const jsonRecords = results.map((r) => {
    if (r.error) {
      return { config: r.config, error: r.error };
    }
    return { config: r.config, runners: r.data.runners };
  });

  writeFileSync(
    join(resultsDir, `${baseName}.json`),
    JSON.stringify(jsonRecords, null, 2) + "\n",
    "utf8",
  );

  const firstConfig = results[0]?.config ?? {};
  const repoFiles = (firstConfig.HYPERION_FILE_COUNT ?? "?").toLocaleString();

  const title =
    sweepName
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase()) + " Sweep Results";

  const isAgentSearch = results[0]?.config?.HYPERION_MODE === "agent-search";

  let md = `# ${title}\n`;
  md += `**Date:** ${date}\n`;
  md += `**Platform:** ${platform}\n`;
  md += `**Repo files:** ${repoFiles}\n\n`;

  if (isAgentSearch) {
    md += "| Branches | Files/Branch | Total Iterations | Avg Latency (ms) | Total (ms) |\n";
    md += "|---|---|---|---|---|\n";
    for (const result of results) {
      const branches = result.config?.HYPERION_SEARCH_CHECKPOINTS ?? "?";
      const perBranch = result.config?.HYPERION_DIRTY_COUNT ?? "?";
      const iters = result.config?.HYPERION_ITERATIONS ?? "?";
      const runner = result.data?.runners?.[0];
      if (runner && !runner.skipped) {
        md += `| ${branches} | ${perBranch} | ${iters} | ${runner.avgMs.toFixed(3)} | ${runner.totalMs.toFixed(3)} |\n`;
      } else {
        md += `| ${branches} | ${perBranch} | ${iters} | ERROR | - |\n`;
      }
    }
  } else {
    md += "| Dirty Files | Git (ms) | Manifest (ms) | rsync (ms) | tmpfs (ms) | Manifest Speedup |\n";
    md += "|---|---|---|---|---|---|\n";

    for (const result of results) {
      const dirty = result.config?.HYPERION_DIRTY_COUNT ?? "?";
      const runners = result.data?.runners ?? [];

      const git = findRunner(runners, "Legacy");
      const manifest = findRunner(runners, "manifest");
      const rsync = findRunner(runners, "rsync");
      const tmpfs = findRunner(runners, "tmpfs");

      const gitMs = cellMs(git);
      const manifestMs = cellMs(manifest);
      const rsyncMs = cellMs(rsync);
      const tmpfsMs = cellMs(tmpfs);
      const speedup = speedupValue(git, manifest);

      md += `| ${dirty} | ${gitMs} | ${manifestMs} | ${rsyncMs} | ${tmpfsMs} | ${speedup} |\n`;
    }
  }

  writeFileSync(join(resultsDir, `${baseName}.md`), md, "utf8");

  console.error(`\nResults written to:`);
  console.error(`  ${join(resultsDir, `${baseName}.json`)}`);
  console.error(`  ${join(resultsDir, `${baseName}.md`)}`);
}

function findRunner(runners, substr) {
  if (!runners || !Array.isArray(runners)) return null;
  const lower = substr.toLowerCase();
  return runners.find((r) => r.label && r.label.toLowerCase().includes(lower)) ?? null;
}

function cellMs(runner) {
  if (!runner || runner.skipped) return "-";
  return runner.avgMs != null ? runner.avgMs.toFixed(3) : "-";
}

function speedupValue(git, manifest) {
  if (!git || git.skipped || !git.avgMs || git.avgMs <= 0) return "-";
  if (!manifest || manifest.skipped || !manifest.avgMs || manifest.avgMs <= 0) return "-";
  return `${(git.avgMs / manifest.avgMs).toFixed(2)}x`;
}

function parseBenchmarkJsonOutput(stdout) {
  const trimmed = stdout.trim();

  if (trimmed.length === 0) {
    throw new Error("no benchmark output captured");
  }

  const direct = parseCandidateJson(trimmed);
  if (isSweepResultPayload(direct)) {
    return direct;
  }

  const candidates = [];
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        startIndex = i;
      }

      depth += 1;
      continue;
    }

    if (char !== "}" || depth === 0) {
      continue;
    }

    depth -= 1;

    if (depth !== 0 || startIndex < 0) {
      continue;
    }

    const candidate = parseCandidateJson(trimmed.slice(startIndex, i + 1));
    if (isSweepResultPayload(candidate)) {
      candidates.push(candidate);
    }

    startIndex = -1;
  }

  if (candidates.length > 0) {
    return candidates[candidates.length - 1];
  }

  throw new Error(`no valid benchmark JSON object in output: ${previewOutput(trimmed)}`);
}

function parseCandidateJson(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function isSweepResultPayload(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.runners));
}

function previewOutput(stdout) {
  const normalized = stdout.replace(/\s+/g, " ").trim();
  if (normalized.length <= 200) {
    return normalized;
  }

  return `${normalized.slice(0, 200)}...`;
}
