import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import type { Dirent } from "node:fs";

import {
  AttemptJournalStore,
  type AttemptJournalAdapter,
  type AttemptJournalEntry,
} from "../src/internal/attempt-journal.js";
import type { StoredCheckpoint } from "../src/internal/checkpoint-store.js";

describe("AttemptJournalStore", () => {
  it("serializes checkpoint metadata without file contents", () => {
    const adapter = new FakeAttemptJournalAdapter();
    const workspaceRoot = path.resolve("/workspace");
    const sessionRoot = path.join(workspaceRoot, ".hyperion", "checkpoints");
    const store = new AttemptJournalStore({
      sessionRoot,
      adapter,
    });
    const checkpoint = createStoredCheckpoint();

    store.write({
      checkpoint,
      strategy: "pure-manifest",
      sessionId: "session-1",
      workspaceRoot,
    });

    const journal = JSON.parse(
      adapter.readFileSync(path.join(sessionRoot, "checkpoint-1", "journal.json"), "utf8"),
    ) as AttemptJournalEntry;

    assert.equal(journal.schemaVersion, 1);
    assert.equal(journal.checkpointId, "checkpoint-1");
    assert.equal(journal.sessionId, "session-1");
    assert.equal(journal.gitHead, "abc123");
    assert.equal(journal.baseline.gitIndexEntries[0]?.relativePath, "src/index.ts");
    assert.equal(journal.baseline.statEntries[0]?.relativePath, "src/index.ts");
    assert.equal(journal.dirty[0]?.relativePath, "src/index.ts");
    assert.equal(JSON.stringify(journal).includes("original file contents"), false);
  });

  it("does not replace the committed journal when atomic rename fails", () => {
    const adapter = new FakeAttemptJournalAdapter();
    const workspaceRoot = path.resolve("/workspace");
    const sessionRoot = path.join(workspaceRoot, ".hyperion", "checkpoints");
    const store = new AttemptJournalStore({
      sessionRoot,
      adapter,
    });
    const journalPath = path.join(sessionRoot, "checkpoint-1", "journal.json");
    adapter.files.set(path.normalize(journalPath), '{"checkpointId":"old"}\n');
    adapter.throwOnRename = true;

    assert.throws(() =>
      store.write({
        checkpoint: createStoredCheckpoint(),
        strategy: "pure-manifest",
        sessionId: "session-1",
        workspaceRoot,
      }),
    );

    assert.equal(adapter.files.get(journalPath), '{"checkpointId":"old"}\n');
    assert.equal([...adapter.files.keys()].some((filePath) => filePath.includes(".tmp")), false);
  });
});

class FakeAttemptJournalAdapter implements AttemptJournalAdapter {
  public readonly files = new Map<string, string>();
  public throwOnRename = false;
  private readonly directories = new Set<string>();

  public existsSync(targetPath: string): boolean {
    return this.files.has(path.normalize(targetPath)) || this.directories.has(path.normalize(targetPath));
  }

  public mkdirSync(targetPath: string, _options: { recursive: true }): void {
    this.directories.add(path.normalize(targetPath));
  }

  public readdirSync(_targetPath: string, _options: { withFileTypes: true }): Dirent[] {
    return [];
  }

  public readFileSync(targetPath: string, _encoding: BufferEncoding): string {
    const content = this.files.get(path.normalize(targetPath));

    if (content === undefined) {
      throw new Error(`Missing file: ${targetPath}`);
    }

    return content;
  }

  public writeFileSync(targetPath: string, data: string, _encoding: BufferEncoding): void {
    this.files.set(path.normalize(targetPath), data);
  }

  public renameSync(oldPath: string, newPath: string): void {
    if (this.throwOnRename) {
      throw new Error("rename failed");
    }

    const content = this.files.get(path.normalize(oldPath));
    if (content === undefined) {
      throw new Error(`Missing file: ${oldPath}`);
    }

    this.files.set(path.normalize(newPath), content);
    this.files.delete(path.normalize(oldPath));
  }

  public rmSync(targetPath: string, _options: { force?: boolean }): void {
    this.files.delete(path.normalize(targetPath));
  }

  public now(): number {
    return 2;
  }
}

function createStoredCheckpoint(): StoredCheckpoint {
  return {
    id: "checkpoint-1",
    baseline: {
      gitAvailable: true,
      gitHead: "abc123",
      gitIndexEntries: new Map([
        [
          "src/index.ts",
          {
            relativePath: "src/index.ts",
            mode: "100644",
            objectId: "object-id",
            stage: 0,
          },
        ],
      ]),
      statEntries: new Map([
        [
          "src/index.ts",
          {
            relativePath: "src/index.ts",
            type: "file",
            size: 42,
            mtimeMs: 1,
            mode: 0o644,
          },
        ],
      ]),
      ignoredPatterns: ["node_modules/**"],
      capturedAt: 1,
    },
    dirty: new Map([
      [
        "src/index.ts",
        {
          relativePath: "src/index.ts",
          kind: "modified",
          fileType: "file",
          capturedBy: "vfs",
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
      ],
    ]),
    storageNamespace: "/workspace/.hyperion/checkpoints/checkpoint-1",
    status: "active",
    createdAt: 1,
    lock: { locked: false },
  };
}
