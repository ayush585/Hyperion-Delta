import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { HotDirtyBufferStrategy } from "../src/internal/hot-dirty-buffer-strategy.js";
import { PureManifestStrategy } from "../src/internal/pure-manifest-strategy.js";

const tempRoots: string[] = [];

function createTempWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-hot-buffer-"));
  tempRoots.push(root);
  return root;
}

function createStrategy(
  root: string,
  options: Partial<{
    maxFileBytes: number;
    maxTotalBytes: number;
    maxFiles: number;
  }> = {},
): HotDirtyBufferStrategy {
  return new HotDirtyBufferStrategy({
    workspaceRoot: root,
    delegate: new PureManifestStrategy(root, path.join(root, ".hyperion", "checkpoints", "checkpoint")),
    maxFileBytes: options.maxFileBytes ?? 256 * 1024,
    maxTotalBytes: options.maxTotalBytes ?? 8 * 1024 * 1024,
    maxFiles: options.maxFiles ?? 1024,
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("HotDirtyBufferStrategy", () => {
  it("stores small regular-file backups in memory and restores modified files", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const filePath = path.join(root, "source.txt");
    writeFileSync(filePath, "original");

    const record = strategy.backupFile("source.txt");
    writeFileSync(filePath, "mutated");
    const result = strategy.restoreFile("source.txt");

    assert.equal(record.kind, "file");
    assert.equal(record.backupPath, undefined);
    assert.equal(result.restored, true);
    assert.equal(readFileSync(filePath, "utf8"), "original");
    assert.deepEqual(strategy.getDiagnosticsForTests(), {
      enabled: true,
      memoryHits: 1,
      spills: 0,
      bytesUsed: Buffer.byteLength("original"),
      filesUsed: 1,
    });
  });

  it("restores deleted files from memory", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const filePath = path.join(root, "deleted.txt");
    writeFileSync(filePath, "before");

    strategy.backupFile("deleted.txt");
    rmSync(filePath);
    strategy.restoreFile("deleted.txt");

    assert.equal(readFileSync(filePath, "utf8"), "before");
  });

  it("removes created files through delegated created-path cleanup", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const filePath = path.join(root, "created.txt");
    writeFileSync(filePath, "created");

    strategy.deleteCreatedPath("created.txt");

    assert.equal(existsSync(filePath), false);
  });

  it("spills large files to the delegate strategy and restores them", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root, { maxFileBytes: 4 });
    const filePath = path.join(root, "large.txt");
    writeFileSync(filePath, "original-large");

    const record = strategy.backupFile("large.txt");
    writeFileSync(filePath, "mutated");
    strategy.restoreFile("large.txt");

    assert.ok(record.backupPath);
    assert.equal(readFileSync(filePath, "utf8"), "original-large");
    assert.equal(strategy.getDiagnosticsForTests().spills, 1);
    assert.equal(strategy.getDiagnosticsForTests().memoryHits, 0);
  });

  it("spills when total byte or file-count limits are reached", () => {
    const root = createTempWorkspace();
    const totalLimited = createStrategy(root, { maxTotalBytes: 3 });
    writeFileSync(path.join(root, "a.txt"), "abc");
    writeFileSync(path.join(root, "b.txt"), "d");

    const first = totalLimited.backupFile("a.txt");
    const second = totalLimited.backupFile("b.txt");

    assert.equal(first.backupPath, undefined);
    assert.ok(second.backupPath);
    assert.equal(totalLimited.getDiagnosticsForTests().spills, 1);

    const fileLimited = createStrategy(root, { maxFiles: 1 });
    writeFileSync(path.join(root, "c.txt"), "c");
    writeFileSync(path.join(root, "d.txt"), "d");

    const third = fileLimited.backupFile("c.txt");
    const fourth = fileLimited.backupFile("d.txt");

    assert.equal(third.backupPath, undefined);
    assert.ok(fourth.backupPath);
    assert.equal(fileLimited.getDiagnosticsForTests().spills, 1);
  });

  it("does not double-count repeated backups of the same path", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    writeFileSync(path.join(root, "same.txt"), "same");

    strategy.backupFile("same.txt");
    strategy.backupFile("same.txt");

    assert.deepEqual(strategy.getDiagnosticsForTests(), {
      enabled: true,
      memoryHits: 1,
      spills: 0,
      bytesUsed: Buffer.byteLength("same"),
      filesUsed: 1,
    });
  });
});
