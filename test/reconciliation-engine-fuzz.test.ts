import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StoredCheckpoint } from "../src/internal/checkpoint-store.js";
import { ReconciliationEngine } from "../src/internal/reconciliation-engine.js";
import type { StateManifest, StatLedgerEntry } from "../src/types.js";

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
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

function createManifest(statEntries: ReadonlyArray<StatLedgerEntry>): StateManifest {
  return {
    gitAvailable: false,
    gitIndexEntries: new Map(),
    statEntries: new Map(statEntries.map((entry) => [entry.relativePath, entry])),
    ignoredPatterns: [],
    capturedAt: 1,
  };
}

function createCheckpoint(id: string, baseline: StateManifest): StoredCheckpoint {
  return {
    id,
    baseline,
    dirty: new Map(),
    storageNamespace: `.hyperion/checkpoints/${id}`,
    status: "active",
    createdAt: 1,
    lock: { locked: false },
  };
}

function randomEntry(relativePath: string, random: () => number): StatLedgerEntry {
  const fileTypes: Array<StatLedgerEntry["type"]> = ["file", "directory", "symlink"];
  return {
    relativePath,
    type: fileTypes[Math.floor(random() * fileTypes.length)] ?? "file",
    size: Math.floor(random() * 1024),
    mtimeMs: Math.floor(random() * 10_000),
    mode: 0o644 + Math.floor(random() * 0o10),
  };
}

function generateManifestEntries(seed: number, count: number): {
  baselineEntries: StatLedgerEntry[];
  currentEntries: StatLedgerEntry[];
} {
  const random = createSeededRandom(seed);
  const baselineEntries: StatLedgerEntry[] = [];
  const currentEntries: StatLedgerEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    const relativePath = `fuzz/path-${index}.txt`;
    const includeBaseline = random() > 0.2;
    const includeCurrent = random() > 0.2;

    if (includeBaseline) {
      baselineEntries.push(randomEntry(relativePath, random));
    }

    if (includeCurrent) {
      if (includeBaseline && random() > 0.6) {
        const baselineEntry = baselineEntries[baselineEntries.length - 1];
        if (baselineEntry) {
          currentEntries.push({
            ...baselineEntry,
            size: baselineEntry.size + 1,
            mtimeMs: baselineEntry.mtimeMs + 1,
          });
          continue;
        }
      }

      currentEntries.push(randomEntry(relativePath, random));
    }
  }

  return { baselineEntries, currentEntries };
}

describe("ReconciliationEngine fuzz", () => {
  it("keeps reconcile categories disjoint and deterministic across random manifests", () => {
    const seedCount = readEnvInteger("HYPERION_RECONCILE_FUZZ_SEEDS", 10);
    const entryCount = readEnvInteger("HYPERION_RECONCILE_FUZZ_ENTRIES", 60);
    const engine = new ReconciliationEngine();

    for (let seed = 1; seed <= seedCount; seed += 1) {
      const { baselineEntries, currentEntries } = generateManifestEntries(seed, entryCount);
      const baseline = createManifest(baselineEntries);
      const current = createManifest(currentEntries);
      const firstCheckpoint = createCheckpoint(`checkpoint-${seed}-a`, baseline);
      const secondCheckpoint = createCheckpoint(`checkpoint-${seed}-b`, baseline);

      const first = engine.reconcile({ checkpoint: firstCheckpoint, currentManifest: current });
      const second = engine.reconcile({ checkpoint: secondCheckpoint, currentManifest: current });

      assert.deepEqual(first, {
        ...second,
        checkpointId: first.checkpointId,
      });

      const createdSet = new Set(first.created);
      const modifiedSet = new Set(first.modified);
      const deletedSet = new Set(first.deleted);
      const renamedFromSet = new Set(first.renamed.map((pair) => pair.from));
      const renamedToSet = new Set(first.renamed.map((pair) => pair.to));

      assert.equal(createdSet.size, first.created.length);
      assert.equal(modifiedSet.size, first.modified.length);
      assert.equal(deletedSet.size, first.deleted.length);
      assert.equal(renamedFromSet.size, first.renamed.length);
      assert.equal(renamedToSet.size, first.renamed.length);

      for (const path of first.created) {
        assert.equal(modifiedSet.has(path), false);
        assert.equal(deletedSet.has(path), false);
        assert.equal(renamedToSet.has(path), false);
      }

      for (const path of first.deleted) {
        assert.equal(modifiedSet.has(path), false);
        assert.equal(renamedFromSet.has(path), false);
      }
    }
  });
});
