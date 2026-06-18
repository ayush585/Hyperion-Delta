import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";

const CONFIG_PATH = process.env["HYPERION_CONFIG"];
if (CONFIG_PATH) {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith("HYPERION_") && value !== undefined && value !== null) {
        process.env[key] = String(value);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: Failed to load HYPERION_CONFIG from ${CONFIG_PATH}: ${message}`);
  }
}

const FILE_COUNT = readPositiveIntegerEnv("HYPERION_FILE_COUNT", 50_000);
const DIRECTORY_DEPTH = readPositiveIntegerEnv("HYPERION_DIRECTORY_DEPTH", 10);
const ITERATIONS = readPositiveIntegerEnv("HYPERION_ITERATIONS", 50);
const DIRTY_COUNT = readPositiveIntegerEnv("HYPERION_DIRTY_COUNT", 1);

const OUTPUT_JSON = process.argv.includes("--json") || process.env["HYPERION_OUTPUT"] === "json";

console.log(`Config: FILE_COUNT=${FILE_COUNT} DIRTY_COUNT=${DIRTY_COUNT} DIRECTORY_DEPTH=${DIRECTORY_DEPTH} ITERATIONS=${ITERATIONS}`);

const ROOT_DIR = resolve(__dirname);
const WORK_ROOT_DIR = resolveWorkRoot();
const BASE_DIR = join(WORK_ROOT_DIR, ".hyperion_base_workspace");
const GIT_DIR = join(WORK_ROOT_DIR, ".hyperion_git_workspace");
const MANIFEST_DIR = join(WORK_ROOT_DIR, ".hyperion_manifest_workspace");
const RSYNC_DIR = join(WORK_ROOT_DIR, ".hyperion_rsync_workspace");
const RSYNC_FILE_LIST = join(WORK_ROOT_DIR, `.hyperion_rsync_files_${process.pid}.txt`);
const TMPFS_ROOT = join("/dev/shm", `hyperion-delta-bench-${process.pid}`);
const TMPFS_BASE_DIR = join(TMPFS_ROOT, "base");
const TMPFS_WORKING_DIR = join(TMPFS_ROOT, "working");

type MutationManifest = {
  modifiedTrackedFiles: string[];
  createdFiles: string[];
};

type RunnerStats = {
  label: string;
  samplesNs: bigint[];
  skippedReason?: string;
};

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizePathForDirectory(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function resolveWorkRoot(): string {
  if (process.env.HYPERION_WORK_ROOT) {
    return resolve(process.env.HYPERION_WORK_ROOT);
  }

  if (isWsl2() && isWindowsMountPath(ROOT_DIR)) {
    return join("/tmp", `hyperion-delta-bench-${sanitizePathForDirectory(ROOT_DIR)}`);
  }

  return ROOT_DIR;
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

function sumNs(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function averageNs(values: bigint[]): bigint {
  return values.length === 0 ? 0n : sumNs(values) / BigInt(values.length);
}

function timeBlock<T>(fn: () => T): { result: T; elapsedNs: bigint } {
  const start = process.hrtime.bigint();
  const result = fn();
  const end = process.hrtime.bigint();
  return { result, elapsedNs: end - start };
}

function run(command: string, cwd: string): void {
  execSync(command, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Hyperion Delta-Bench",
      GIT_AUTHOR_EMAIL: "hyperion@example.invalid",
      GIT_COMMITTER_NAME: "Hyperion Delta-Bench",
      GIT_COMMITTER_EMAIL: "hyperion@example.invalid",
    },
  });
}

function hasCommand(binary: string, args: string[] = ["--version"]): boolean {
  try {
    execFileSync(binary, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function chmodTree(root: string, fileMode: number, directoryMode: number): void {
  if (!existsSync(root)) {
    return;
  }

  const stat = statSync(root);
  if (!stat.isDirectory()) {
    chmodSync(root, fileMode);
    return;
  }

  chmodSync(root, directoryMode);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      chmodTree(path, fileMode, directoryMode);
    } else {
      chmodSync(path, fileMode);
    }
  }
}

function isWindowsMountPath(path: string): boolean {
  return platform === "linux" && /^\/mnt\/[a-z](\/|$)/i.test(path);
}

function chmodDirectories(root: string, directoryMode: number): void {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return;
  }

  chmodSync(root, directoryMode);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      chmodDirectories(join(root, entry.name), directoryMode);
    }
  }
}

function makeWritable(root: string): void {
  if (isWindowsMountPath(root)) {
    return;
  }

  chmodTree(root, 0o644, 0o755);
}

function makeReadOnly(root: string): void {
  if (isWindowsMountPath(root)) {
    return;
  }

  chmodTree(root, 0o444, 0o555);
}

function safeRmDir(path: string): void {
  if (existsSync(path)) {
    try {
      chmodDirectories(path, 0o755);
    } catch {
      // Best effort: rmSync can still remove many read-only files on POSIX.
    }
  }
  rmSync(path, { recursive: true, force: true });
}

function relativeFilePathFor(index: number): string {
  const directoryParts: string[] = [];

  for (let depth = 0; depth < DIRECTORY_DEPTH; depth += 1) {
    directoryParts.push(`layer_${depth}_${Math.floor(index / (depth + 1)) % 97}`);
  }

  return join(...directoryParts, `module_${index}.ts`);
}

function filePathFor(index: number, root: string): string {
  return join(root, relativeFilePathFor(index));
}

function synthesizeBaseMonorepo(): bigint {
  safeRmDir(BASE_DIR);
  safeRmDir(GIT_DIR);
  safeRmDir(MANIFEST_DIR);
  safeRmDir(RSYNC_DIR);
  safeRmDir(TMPFS_ROOT);

  const { elapsedNs } = timeBlock(() => {
    for (let index = 0; index < FILE_COUNT; index += 1) {
      const filePath = filePathFor(index, BASE_DIR);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        [
          `export const module_${index} = ${index};`,
          `export function value_${index}(): number {`,
          `  return module_${index};`,
          "}",
          "",
        ].join("\n"),
      );
    }
  });

  makeReadOnly(BASE_DIR);
  return elapsedNs;
}

function createWritableWorkspace(source: string, destination: string): void {
  safeRmDir(destination);
  cpSync(source, destination, { recursive: true });
  makeWritable(destination);
}

function initializeGitRepository(): bigint {
  createWritableWorkspace(BASE_DIR, GIT_DIR);

  const { elapsedNs } = timeBlock(() => {
    run("git init -q", GIT_DIR);
    run("git config user.name \"Hyperion Delta-Bench\"", GIT_DIR);
    run("git config user.email hyperion@example.invalid", GIT_DIR);
    run("git add .", GIT_DIR);
    run("git commit -q -m baseline", GIT_DIR);
  });

  return elapsedNs;
}

function mutationTargetIndex(iteration: number): number {
  return FILE_COUNT - 1 - (iteration % 997);
}

function materializeTrackedFileFromBase(baseRoot: string, workingRoot: string, relativePath: string): void {
  const source = join(baseRoot, relativePath);
  const target = join(workingRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  copyFileSync(source, target);
  chmodSync(target, 0o644);
}

function mutateWorkspace(
  root: string,
  iteration: number,
  count: number,
  prepareTrackedFile?: (relativePath: string) => void,
): MutationManifest {
  const modifiedTrackedFiles: string[] = [];
  const createdFiles: string[] = [];

  for (let d = 0; d < count; d += 1) {
    const fileIndex = FILE_COUNT - 1 - ((iteration * count + d) % 997) % FILE_COUNT;
    const targetRelativePath = relativeFilePathFor(fileIndex);
    const targetFile = join(root, targetRelativePath);
    const createdRelativePath = join(
      "scratch",
      `agent_mistake_${String(iteration).padStart(2, "0")}_${d}.tmp`,
    );
    const createdFile = join(root, createdRelativePath);

    prepareTrackedFile?.(targetRelativePath);
    writeFileSync(
      targetFile,
      [
        `export const broken_${iteration}_${d} = ${iteration};`,
        "throw new Error(\"agent mistake\");",
        "",
      ].join("\n"),
    );

    mkdirSync(dirname(createdFile), { recursive: true });
    writeFileSync(createdFile, `temporary failed branch ${iteration}_${d}\n`);

    modifiedTrackedFiles.push(targetRelativePath);
    createdFiles.push(createdRelativePath);
  }

  return {
    modifiedTrackedFiles,
    createdFiles,
  };
}

function runLegacyRunner(): RunnerStats {
  const samplesNs: bigint[] = [];

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    mutateWorkspace(GIT_DIR, iteration, DIRTY_COUNT);

    const { elapsedNs } = timeBlock(() => {
      run("git reset --hard HEAD", GIT_DIR);
      run("git clean -fd", GIT_DIR);
    });

    samplesNs.push(elapsedNs);
  }

  return {
    label: "Legacy Runner (git reset --hard + git clean -fd)",
    samplesNs,
  };
}

function revertFromManifest(baseRoot: string, workingRoot: string, manifest: MutationManifest): void {
  for (const relativePath of manifest.createdFiles) {
    rmSync(join(workingRoot, relativePath), { recursive: true, force: true });
  }

  for (const relativePath of manifest.modifiedTrackedFiles) {
    materializeTrackedFileFromBase(baseRoot, workingRoot, relativePath);
  }
}

function runManifestTargetedRunner(): RunnerStats {
  createWritableWorkspace(BASE_DIR, MANIFEST_DIR);

  const samplesNs: bigint[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const manifest = mutateWorkspace(MANIFEST_DIR, iteration, DIRTY_COUNT);

    const { elapsedNs } = timeBlock(() => {
      revertFromManifest(BASE_DIR, MANIFEST_DIR, manifest);
    });

    samplesNs.push(elapsedNs);
  }

  return {
    label: "Targeted Reversion (manifest file restore)",
    samplesNs,
  };
}

function createRsyncLinkedWorkspace(baseRoot: string, workingRoot: string): void {
  safeRmDir(workingRoot);
  mkdirSync(workingRoot, { recursive: true });
  execFileSync(
    "rsync",
    ["-a", `--link-dest=${baseRoot}`, `${baseRoot}/`, `${workingRoot}/`],
    { stdio: "ignore" },
  );
  if (!isWindowsMountPath(workingRoot)) {
    chmodDirectories(workingRoot, 0o755);
  }
}

function revertWithRsyncFileList(baseRoot: string, workingRoot: string, manifest: MutationManifest): void {
  for (const relativePath of manifest.createdFiles) {
    rmSync(join(workingRoot, relativePath), { recursive: true, force: true });
  }

  writeFileSync(RSYNC_FILE_LIST, `${manifest.modifiedTrackedFiles.join("\n")}\n`);
  try {
    execFileSync(
      "rsync",
      ["-a", "--files-from", RSYNC_FILE_LIST, `${baseRoot}/`, `${workingRoot}/`],
      { stdio: "ignore" },
    );
  } finally {
    rmSync(RSYNC_FILE_LIST, { force: true });
  }
}

function runRsyncTargetedRunner(): RunnerStats {
  if (!hasCommand("rsync")) {
    return {
      label: "Targeted Reversion (rsync file-list/link-dest)",
      samplesNs: [],
      skippedReason: "rsync is not available on PATH",
    };
  }

  createRsyncLinkedWorkspace(BASE_DIR, RSYNC_DIR);

  const samplesNs: bigint[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const manifest = mutateWorkspace(RSYNC_DIR, iteration, DIRTY_COUNT, (relativePath) => {
      materializeTrackedFileFromBase(BASE_DIR, RSYNC_DIR, relativePath);
    });

    const { elapsedNs } = timeBlock(() => {
      revertWithRsyncFileList(BASE_DIR, RSYNC_DIR, manifest);
    });

    samplesNs.push(elapsedNs);
  }

  return {
    label: "Targeted Reversion (rsync file-list/link-dest)",
    samplesNs,
  };
}

function isWsl2(): boolean {
  if (platform !== "linux" || !existsSync("/proc/version")) {
    return false;
  }

  return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
}

function prepareTmpfsWorkspace(): string | undefined {
  if (platform !== "linux") {
    return "tmpfs mode is only available on Linux/WSL2";
  }

  if (!existsSync("/dev/shm")) {
    return "/dev/shm is not available";
  }

  try {
    safeRmDir(TMPFS_ROOT);
    mkdirSync(TMPFS_BASE_DIR, { recursive: true });
    mkdirSync(TMPFS_WORKING_DIR, { recursive: true });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `could not prepare /dev/shm dirty-set cache: ${message}`;
  }
}

function runTmpfsTargetedRunner(): RunnerStats {
  const skippedReason = prepareTmpfsWorkspace();
  if (skippedReason) {
    return {
      label: "Targeted Reversion (tmpfs manifest restore)",
      samplesNs: [],
      skippedReason,
    };
  }

  const samplesNs: bigint[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    for (let d = 0; d < DIRTY_COUNT; d += 1) {
      const fileIndex = FILE_COUNT - 1 - ((iteration * DIRTY_COUNT + d) % 997) % FILE_COUNT;
      const relativePath = relativeFilePathFor(fileIndex);
      materializeTrackedFileFromBase(BASE_DIR, TMPFS_BASE_DIR, relativePath);
      materializeTrackedFileFromBase(TMPFS_BASE_DIR, TMPFS_WORKING_DIR, relativePath);
    }
    const manifest = mutateWorkspace(TMPFS_WORKING_DIR, iteration, DIRTY_COUNT);

    const { elapsedNs } = timeBlock(() => {
      revertFromManifest(TMPFS_BASE_DIR, TMPFS_WORKING_DIR, manifest);
    });

    samplesNs.push(elapsedNs);
  }

  safeRmDir(TMPFS_ROOT);

  return {
    label: `Targeted Reversion (tmpfs dirty-set restore${isWsl2() ? ", WSL2" : ""})`,
    samplesNs,
  };
}

function formatMs(ns: bigint): string {
  return `${nsToMs(ns).toLocaleString(undefined, {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })} ms`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function metricRow(stats: RunnerStats, legacyTotal: bigint): string[] {
  if (stats.skippedReason) {
    return [stats.label, `skipped: ${stats.skippedReason}`, "-", "-", "-", "-"];
  }

  const total = sumNs(stats.samplesNs);
  const speedup = total === 0n ? Number.POSITIVE_INFINITY : Number(legacyTotal) / Number(total);
  const reduction = legacyTotal === 0n ? 0 : (1 - Number(total) / Number(legacyTotal)) * 100;

  return [
    stats.label,
    formatMs(total),
    formatMs(averageNs(stats.samplesNs)),
    String(stats.samplesNs.length),
    `${speedup.toFixed(2)}x`,
    `${reduction.toFixed(2)}%`,
  ];
}

function printTable(runners: RunnerStats[]): void {
  const legacy = runners[0];
  const legacyTotal = sumNs(legacy.samplesNs);
  const rows = runners.map((runner) => metricRow(runner, legacyTotal));
  const headers = [
    "Runner",
    "Total I/O Block Time",
    "Average Rollback Latency",
    "Samples",
    "Speedup vs Git",
    "Reduction vs Git",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const divider = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;

  console.log("\nHyperion Delta-Bench: Targeted State Reversion");
  console.log(divider);
  console.log(`| ${headers.map((header, index) => pad(header, widths[index])).join(" | ")} |`);
  console.log(divider);
  for (const row of rows) {
    console.log(`| ${row.map((cell, index) => pad(cell, widths[index])).join(" | ")} |`);
  }
  console.log(divider);
}

function status(message: string): void {
  if (OUTPUT_JSON) {
    console.error(message);
  } else {
    console.log(message);
  }
}

function printJsonResults(runners: RunnerStats[]): void {
  const legacy = runners[0];
  const legacyTotal = sumNs(legacy.samplesNs);
  const output = {
    config: {
      fileCount: FILE_COUNT,
      directoryDepth: DIRECTORY_DEPTH,
      iterations: ITERATIONS,
      dirtyCount: DIRTY_COUNT,
      platform: platform,
      wsl2: isWsl2(),
    },
    runners: runners.map((stats) => {
      if (stats.skippedReason) {
        return {
          label: stats.label,
          totalMs: 0,
          avgMs: 0,
          samples: 0,
          speedup: 0,
          reduction: 0,
          skipped: true,
        };
      }
      const total = sumNs(stats.samplesNs);
      const speedup = total === 0n ? 0 : Number(legacyTotal) / Number(total);
      const reduction = legacyTotal === 0n ? 0 : (1 - Number(total) / Number(legacyTotal)) * 100;
      return {
        label: stats.label,
        totalMs: nsToMs(total),
        avgMs: nsToMs(averageNs(stats.samplesNs)),
        samples: stats.samplesNs.length,
        speedup: Number(speedup.toFixed(2)),
        reduction: Number(reduction.toFixed(2)),
        skipped: false,
      };
    }),
  };
  console.log(JSON.stringify(output, null, 2));
}

function printResults(runners: RunnerStats[]): void {
  if (OUTPUT_JSON) {
    printJsonResults(runners);
  } else {
    printTable(runners);
  }
}

const SEARCH_CHECKPOINTS = readPositiveIntegerEnv("HYPERION_SEARCH_CHECKPOINTS", 5);
const AGENT_SEARCH_MODE = process.env.HYPERION_MODE === "agent-search";
const SKIP_LEGACY = process.env.HYPERION_SKIP_LEGACY === "true";

function runAgentSearchRunner(): RunnerStats {
  const searchBase = join(WORK_ROOT_DIR, ".hyperion_agent_search_git");
  createWritableWorkspace(BASE_DIR, searchBase);
  run("git init -q", searchBase);
  run("git add .", searchBase);
  run("git commit -q -m search-baseline", searchBase);

  const searchDir = join(WORK_ROOT_DIR, ".hyperion_agent_search_workspace");
  const samplesNs: bigint[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    safeRmDir(searchDir);
    cpSync(searchBase, searchDir, { recursive: true });
    makeWritable(searchDir);

    const { elapsedNs } = timeBlock(() => {
      for (let branch = 0; branch < SEARCH_CHECKPOINTS; branch += 1) {
        for (let d = 0; d < DIRTY_COUNT; d += 1) {
          const fileIndex = FILE_COUNT - 1 - ((branch * DIRTY_COUNT + d + iteration * 1000) % 997) % FILE_COUNT;
          const filePath = filePathFor(fileIndex, searchDir);
          writeFileSync(
            filePath,
            `export const branch_${branch}_${d} = "branch-${branch}";\n`,
          );
          const scratchPath = join(searchDir, "scratch", `branch_${branch}_agent_${d}.tmp`);
          mkdirSync(dirname(scratchPath), { recursive: true });
          writeFileSync(scratchPath, `branch ${branch} scratch ${d}\n`);
        }
      }
    });
    samplesNs.push(elapsedNs);
  }

  safeRmDir(searchBase);
  safeRmDir(searchDir);

  return {
    label: `Agent-Search Stress (${SEARCH_CHECKPOINTS} concurrent branches × ${DIRTY_COUNT} files each)`,
    samplesNs,
  };
}

function printRunnerComplete(stats: RunnerStats): void {
  if (stats.skippedReason) {
    status(`${stats.label} skipped: ${stats.skippedReason}`);
    return;
  }

  status(`${stats.label} complete in ${formatMs(sumNs(stats.samplesNs))}`);
}

function main(): void {
  status("Hyperion Delta-Bench");
  status(`Platform: ${platform}${isWsl2() ? " (WSL2)" : ""}`);
  status(`Work root: ${WORK_ROOT_DIR}`);
  status(`Fixture: ${FILE_COUNT.toLocaleString()} TypeScript files, ${DIRECTORY_DEPTH} layers deep`);
  status(`Iterations: ${ITERATIONS}`);
  status("Strategy: compare Git whole-tree reset against targeted modified-file rollback");

  status("\nPhase 1: Synthesizing read-only base monorepo...");
  const synthesizeNs = synthesizeBaseMonorepo();
  status(`Phase 1 complete in ${formatMs(synthesizeNs)}`);

  if (AGENT_SEARCH_MODE) {
    status(`\nPhase 2: Running Agent-Search Stress Test (${SEARCH_CHECKPOINTS} branches × ${DIRTY_COUNT} files each)...`);
    const search = runAgentSearchRunner();
    printRunnerComplete(search);
    printResults([search]);
  } else {
    let legacyRunner: RunnerStats | undefined;

    if (!SKIP_LEGACY) {
      const gitInitNs = initializeGitRepository();
      status(`Git baseline complete in ${formatMs(gitInitNs)}`);

      status("\nPhase 2: Running Legacy Runner control group...");
      legacyRunner = runLegacyRunner();
      printRunnerComplete(legacyRunner);
    }

    status("\nPhase 3: Running optimized targeted reversion runners...");
    const manifest = runManifestTargetedRunner();
    printRunnerComplete(manifest);

    const rsync = runRsyncTargetedRunner();
    printRunnerComplete(rsync);

    const tmpfs = runTmpfsTargetedRunner();
    printRunnerComplete(tmpfs);

    const runners: RunnerStats[] = legacyRunner
      ? [legacyRunner, manifest, rsync, tmpfs]
      : [manifest, rsync, tmpfs];

    printResults(runners);

    if (!OUTPUT_JSON) {
      console.log("\nMetadata lesson: full directory clone/delete was intentionally removed from Phase 3.");
      console.log("The optimized runners only touch files the simulated agent changed.");
    }
  }
}

try {
  if (!existsSync(ROOT_DIR)) {
    throw new Error(`Benchmark root does not exist: ${ROOT_DIR}`);
  }

  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nBenchmark failed: ${message}`);
  process.exitCode = 1;
} finally {
  rmSync(RSYNC_FILE_LIST, { force: true });
}
