import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { HyperionWorkspace, type CheckpointId } from "../src/index.js";

const require = createRequire(import.meta.url);
const tempRoots: string[] = [];
const activeWorkspaces: HyperionWorkspace[] = [];

function getCommonJsFs(): typeof import("node:fs") {
  return require("node:fs") as typeof import("node:fs");
}

function createTempWorkspaceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-vfs-fuzz-"));
  tempRoots.push(root);
  return root;
}

function createWorkspace(root: string): HyperionWorkspace {
  const workspace = new HyperionWorkspace(root);
  workspace.installFsInterceptor();
  activeWorkspaces.push(workspace);
  return workspace;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function readEnvInteger(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pathWithinWorkspace(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

function pickFromSet(set: Set<string>, random: () => number): string | undefined {
  if (set.size === 0) {
    return undefined;
  }

  const values = [...set];
  const index = Math.floor(random() * values.length);
  return values[index];
}

function createGeneratedPath(seed: number, index: number): string {
  return `fuzz/seed-${seed}/path-${index}.txt`;
}

function snapshotWorkspaceFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();

  const scan = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolutePath = path.join(directory, entry);
      const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, "/");

      if (relativePath === ".hyperion" || relativePath.startsWith(".hyperion/")) {
        continue;
      }

      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        scan(absolutePath);
        continue;
      }

      if (stat.isFile()) {
        files.set(relativePath, readFileSync(absolutePath, "utf8"));
      }
    }
  };

  scan(root);
  return files;
}

function seedBaseline(root: string): Map<string, string> {
  mkdirSync(pathWithinWorkspace(root, "src"), { recursive: true });
  mkdirSync(pathWithinWorkspace(root, "fixtures"), { recursive: true });
  writeFileSync(pathWithinWorkspace(root, "src/seed-a.txt"), "alpha\n");
  writeFileSync(pathWithinWorkspace(root, "fixtures/seed-b.txt"), "beta\n");

  return snapshotWorkspaceFiles(root);
}

function runMutationFuzz(input: {
  root: string;
  checkpointId: CheckpointId;
  seed: number;
  operations: number;
}): void {
  const fs = getCommonJsFs();
  const random = createSeededRandom(input.seed);
  const knownFiles = new Set(snapshotWorkspaceFiles(input.root).keys());
  let generatedIndex = 0;

  for (let operationIndex = 0; operationIndex < input.operations; operationIndex += 1) {
    const operationKind = Math.floor(random() * 5);

    if (operationKind === 0) {
      const existingPath = pickFromSet(knownFiles, random);
      const relativePath = existingPath ?? createGeneratedPath(input.seed, generatedIndex++);
      const absolutePath = pathWithinWorkspace(input.root, relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(
        absolutePath,
        `seed=${input.seed};checkpoint=${input.checkpointId};op=${operationIndex};kind=write\n`,
      );
      knownFiles.add(relativePath);
      continue;
    }

    if (operationKind === 1) {
      const existingPath = pickFromSet(knownFiles, random);
      const relativePath = existingPath ?? createGeneratedPath(input.seed, generatedIndex++);
      const absolutePath = pathWithinWorkspace(input.root, relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.appendFileSync(absolutePath, `append:${operationIndex}\n`);
      knownFiles.add(relativePath);
      continue;
    }

    if (operationKind === 2) {
      const sourcePath = pickFromSet(knownFiles, random);

      if (!sourcePath) {
        continue;
      }

      const targetPath = createGeneratedPath(input.seed, generatedIndex++);
      const sourceAbsolute = pathWithinWorkspace(input.root, sourcePath);
      const targetAbsolute = pathWithinWorkspace(input.root, targetPath);
      mkdirSync(path.dirname(targetAbsolute), { recursive: true });
      fs.renameSync(sourceAbsolute, targetAbsolute);
      knownFiles.delete(sourcePath);
      knownFiles.add(targetPath);
      continue;
    }

    if (operationKind === 3) {
      const sourcePath = pickFromSet(knownFiles, random);

      if (!sourcePath) {
        continue;
      }

      fs.unlinkSync(pathWithinWorkspace(input.root, sourcePath));
      knownFiles.delete(sourcePath);
      continue;
    }

    const relativePath = createGeneratedPath(input.seed, generatedIndex++);
    const absolutePath = pathWithinWorkspace(input.root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `nested:${operationIndex}\n`);
    knownFiles.add(relativePath);
  }
}

afterEach(async () => {
  while (activeWorkspaces.length > 0) {
    await activeWorkspaces.pop()?.dispose();
  }

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();

    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("VFS interceptor fuzz", () => {
  it("restores workspace baselines after deterministic random mutation batches", async () => {
    const seedCount = readEnvInteger("HYPERION_FUZZ_SEEDS", 5);
    const operationCount = readEnvInteger("HYPERION_FUZZ_OPS", 50);

    for (let seed = 1; seed <= seedCount; seed += 1) {
      const root = createTempWorkspaceRoot();
      const baseline = seedBaseline(root);
      const workspace = createWorkspace(root);
      const checkpointId = await workspace.snapshot();

      runMutationFuzz({
        root,
        checkpointId,
        seed,
        operations: operationCount,
      });

      await workspace.rollback(checkpointId);

      assert.deepEqual(
        [...snapshotWorkspaceFiles(root).entries()].sort(),
        [...baseline.entries()].sort(),
        `workspace mismatch after seed ${seed}`,
      );
      assert.equal(workspace.getDiagnostics().activeCheckpointCount, 0);

      await workspace.dispose();
      const workspaceIndex = activeWorkspaces.indexOf(workspace);
      if (workspaceIndex >= 0) {
        activeWorkspaces.splice(workspaceIndex, 1);
      }

      rmSync(root, { recursive: true, force: true });
      const rootIndex = tempRoots.indexOf(root);
      if (rootIndex >= 0) {
        tempRoots.splice(rootIndex, 1);
      }
    }
  });
});
