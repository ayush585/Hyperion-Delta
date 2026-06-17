#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "hyperion-package-smoke-"));
const sampleRoot = join(tempRoot, "sample-project");
const workspaceRoot = join(tempRoot, "workspace");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  mkdirSync(sampleRoot, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });

  const packOutput = run(npmCommand, ["pack", "--pack-destination", tempRoot, "--json"], {
    cwd: repoRoot,
    captureOutput: true,
  });
  const tarballPath = resolve(tempRoot, parsePackFilename(packOutput));

  if (!existsSync(tarballPath)) {
    throw new Error(`Packed tarball was not created: ${tarballPath}`);
  }

  writeFileSync(
    join(sampleRoot, "package.json"),
    `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`,
  );
  run(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: sampleRoot,
  });

  const smokeScript = join(sampleRoot, "smoke.mjs");
  writeFileSync(
    smokeScript,
    [
      "import { HyperionWorkspace, HyperionAgentSession } from 'hyperion-delta';",
      `const workspaceRoot = ${JSON.stringify(workspaceRoot)};`,
      "const workspace = new HyperionWorkspace({ workspaceRoot, useTmpfs: false });",
      "const checkpointId = await workspace.snapshot();",
      "if (typeof checkpointId !== 'string' || checkpointId.length === 0) throw new Error('snapshot failed');",
      "await workspace.dispose();",
      "const session = new HyperionAgentSession({ workspaceRoot, useTmpfs: false });",
      "if (typeof session.strategy !== 'string') throw new Error('missing strategy');",
      "await session.dispose();",
      "console.log('Package install smoke passed');",
      "",
    ].join("\n"),
  );
  run(process.execPath, [smokeScript], { cwd: sampleRoot });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function run(
  command,
  args,
  options = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && command === npmCommand,
    stdio: options.captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const spawnError = result.error ? `\n${result.error.message}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${spawnError}${output ? `\n${output}` : ""}`);
  }

  return result.stdout ?? "";
}

function parsePackFilename(output) {
  const parsed = JSON.parse(output);
  const firstEntry = Array.isArray(parsed) ? parsed[0] : undefined;

  if (!firstEntry || typeof firstEntry.filename !== "string") {
    throw new Error("npm pack did not return a tarball filename");
  }

  return firstEntry.filename;
}
