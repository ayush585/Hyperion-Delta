import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StoredCheckpoint } from "../src/internal/checkpoint-store.js";
import { ReconciliationEngine } from "../src/internal/reconciliation-engine.js";
import type { StateManifest, StatLedgerEntry } from "../src/types.js";

function createEntry(
  relativePath: string,
  overrides: Partial<StatLedgerEntry> = {},
): StatLedgerEntry {
  return {
    relativePath,
    type: "file",
    size: 1,
    mtimeMs: 1,
    mode: 0o100644,
    ...overrides,
  };
}

function createManifest(entries: StatLedgerEntry[]): StateManifest {
  return {
    gitAvailable: false,
    gitIndexEntries: new Map(),
    statEntries: new Map(entries.map((entry) => [entry.relativePath, entry])),
    ignoredPatterns: [],
    capturedAt: 1,
  };
}

function createCheckpoint(baseline: StateManifest): StoredCheckpoint {
  return {
    id: "checkpoint-1",
    baseline,
    dirty: new Map(),
    storageNamespace: "/tmp/checkpoint-1",
    status: "active",
    createdAt: 1,
    lock: { locked: false },
  };
}

describe("ReconciliationEngine", () => {
  it("removes dirty entries when a modified path returns exactly to baseline", () => {
    const baseline = createManifest([createEntry("source.txt")]);
    const checkpoint = createCheckpoint(baseline);
    const engine = new ReconciliationEngine();

    engine.reconcile({
      checkpoint,
      currentManifest: createManifest([createEntry("source.txt", { size: 2, mtimeMs: 2 })]),
    });
    assert.equal(checkpoint.dirty.has("source.txt"), true);

    engine.reconcile({
      checkpoint,
      currentManifest: createManifest([createEntry("source.txt")]),
    });

    assert.equal(checkpoint.dirty.has("source.txt"), false);
  });

  it("preserves existing capture source while refreshing dirty metadata", () => {
    const baseline = createManifest([createEntry("source.txt")]);
    const checkpoint = createCheckpoint(baseline);
    const engine = new ReconciliationEngine();
    checkpoint.dirty.set("source.txt", {
      relativePath: "source.txt",
      kind: "modified",
      fileType: "file",
      capturedBy: "track",
      firstSeenAt: 100,
      lastSeenAt: 100,
      before: createEntry("source.txt"),
      after: createEntry("source.txt", { size: 2, mtimeMs: 2 }),
    });

    engine.reconcile({
      checkpoint,
      currentManifest: createManifest([createEntry("source.txt", { size: 3, mtimeMs: 3 })]),
    });

    const dirtyEntry = checkpoint.dirty.get("source.txt");
    assert.equal(dirtyEntry?.capturedBy, "track");
    assert.equal(dirtyEntry?.firstSeenAt, 100);
    assert.equal(dirtyEntry?.after?.size, 3);
  });
});
