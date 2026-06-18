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

  it("reports deterministic one-to-one rename pairs", () => {
    const baseline = createManifest([createEntry("before.txt", { size: 2, mtimeMs: 10 })]);
    const checkpoint = createCheckpoint(baseline);
    const engine = new ReconciliationEngine();

    const result = engine.reconcile({
      checkpoint,
      currentManifest: createManifest([createEntry("after.txt", { size: 2, mtimeMs: 10 })]),
    });

    assert.deepEqual(result.created, []);
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.renamed, [{ from: "before.txt", to: "after.txt" }]);
    assert.equal(checkpoint.dirty.has("before.txt"), true);
    assert.equal(checkpoint.dirty.has("after.txt"), true);
  });

  it("keeps ambiguous rename candidates as create plus delete", () => {
    const baseline = createManifest([
      createEntry("before-a.txt", { size: 3, mtimeMs: 11 }),
      createEntry("before-b.txt", { size: 3, mtimeMs: 11 }),
    ]);
    const checkpoint = createCheckpoint(baseline);
    const engine = new ReconciliationEngine();

    const result = engine.reconcile({
      checkpoint,
      currentManifest: createManifest([
        createEntry("after-a.txt", { size: 3, mtimeMs: 11 }),
        createEntry("after-b.txt", { size: 3, mtimeMs: 11 }),
      ]),
    });

    assert.deepEqual(result.renamed, []);
    assert.deepEqual(result.created, ["after-a.txt", "after-b.txt"]);
    assert.deepEqual(result.deleted, ["before-a.txt", "before-b.txt"]);
  });
});
