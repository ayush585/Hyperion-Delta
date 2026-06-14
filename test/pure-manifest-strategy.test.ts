import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { HyperionIntegrityError, HyperionPathError } from "../src/index.js";
import { PureManifestStrategy } from "../src/internal/pure-manifest-strategy.js";

const tempRoots: string[] = [];

function createTempWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "hyperion-storage-"));
  tempRoots.push(root);
  return root;
}

function createStrategy(root: string): PureManifestStrategy {
  return new PureManifestStrategy(root, path.join(root, ".hyperion", "checkpoints", "checkpoint"));
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("PureManifestStrategy backup behavior", () => {
  it("backs up a regular file into the checkpoint namespace", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    writeFileSync(path.join(root, "source.txt"), "original");

    const record = strategy.backupFile("source.txt");

    assert.equal(record.kind, "file");
    assert.ok(record.backupPath);
    assert.equal(readFileSync(record.backupPath, "utf8"), "original");
    assert.equal(strategy.getBackupRecord("source.txt")?.relativePath, "source.txt");
  });

  it("records missing sources as tombstones without throwing", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);

    const record = strategy.backupFile("missing.txt");

    assert.equal(record.kind, "missing");
    assert.equal(record.backupPath, undefined);
  });

  it("records directories as metadata-only entries", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    writeFileSync(path.join(root, "src", "nested", "file.txt"), "content");

    const record = strategy.backupFile("src");

    assert.equal(record.kind, "directory");
    assert.equal(record.backupPath, undefined);
    assert.equal(existsSync(path.join(root, ".hyperion", "checkpoints", "checkpoint", "files", "src")), false);
  });

  it("rejects backup paths outside the workspace", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);

    assert.throws(() => strategy.backupFile(path.join(root, "..", "outside.txt")), HyperionPathError);
  });
});

describe("PureManifestStrategy restore behavior", () => {
  it("restores a modified file to its backed-up content", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");

    strategy.backupFile("source.txt");
    writeFileSync(sourcePath, "mutated");
    const result = strategy.restoreFile("source.txt");

    assert.deepEqual(result, { relativePath: "source.txt", restored: true, deleted: false });
    assert.equal(readFileSync(sourcePath, "utf8"), "original");
    assert.equal(existsSync(path.join(root, ".hyperion-source.txt.tmp")), false);
  });

  it("recreates parent directories before restoring a deleted file", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const sourcePath = path.join(root, "src", "nested", "source.txt");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "original");

    strategy.backupFile("src/nested/source.txt");
    rmSync(path.join(root, "src"), { recursive: true, force: true });
    strategy.restoreFile("src/nested/source.txt");

    assert.equal(readFileSync(sourcePath, "utf8"), "original");
  });

  it("deletes a path when restoring a tombstone record", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const sourcePath = path.join(root, "created.txt");

    strategy.backupFile("created.txt");
    writeFileSync(sourcePath, "created later");
    const result = strategy.restoreFile("created.txt");

    assert.deepEqual(result, { relativePath: "created.txt", restored: false, deleted: true });
    assert.equal(existsSync(sourcePath), false);
  });

  it("recreates directory records without restoring their child tree", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const directoryPath = path.join(root, "src");
    mkdirSync(path.join(directoryPath, "nested"), { recursive: true });
    writeFileSync(path.join(directoryPath, "nested", "file.txt"), "content");

    strategy.backupFile("src");
    rmSync(directoryPath, { recursive: true, force: true });
    strategy.restoreFile("src");

    assert.equal(existsSync(directoryPath), true);
    assert.equal(existsSync(path.join(directoryPath, "nested", "file.txt")), false);
  });

  it("throws an integrity error without corrupting the target when backup data is missing", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const sourcePath = path.join(root, "source.txt");
    writeFileSync(sourcePath, "original");

    const record = strategy.backupFile("source.txt");
    writeFileSync(sourcePath, "mutated");
    assert.ok(record.backupPath);
    rmSync(record.backupPath, { force: true });

    assert.throws(() => strategy.restoreFile("source.txt"), HyperionIntegrityError);
    assert.equal(readFileSync(sourcePath, "utf8"), "mutated");
  });

  it("restores file mode where the platform supports chmod", { skip: process.platform === "win32" }, () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const sourcePath = path.join(root, "script.sh");
    writeFileSync(sourcePath, "echo hello\n");
    chmodSync(sourcePath, 0o755);

    strategy.backupFile("script.sh");
    chmodSync(sourcePath, 0o644);
    strategy.restoreFile("script.sh");

    assert.equal(statSync(sourcePath).mode & 0o777, 0o755);
  });

  it("restores symlinks when the platform allows creating them", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    const targetPath = path.join(root, "target.txt");
    const linkPath = path.join(root, "target-link.txt");
    writeFileSync(targetPath, "target");

    try {
      symlinkSync("target.txt", linkPath);
    } catch {
      return;
    }

    strategy.backupFile("target-link.txt");
    rmSync(linkPath, { force: true });
    strategy.restoreFile("target-link.txt");

    assert.equal(readlinkSync(linkPath), "target.txt");
  });
});

describe("PureManifestStrategy created-path cleanup", () => {
  it("deletes only the manifest-listed created file", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    writeFileSync(path.join(root, "created.txt"), "created");
    writeFileSync(path.join(root, "unrelated.txt"), "safe");

    strategy.deleteCreatedPath("created.txt");

    assert.equal(existsSync(path.join(root, "created.txt")), false);
    assert.equal(readFileSync(path.join(root, "unrelated.txt"), "utf8"), "safe");
  });

  it("limits recursive deletion to the exact listed path", () => {
    const root = createTempWorkspace();
    const strategy = createStrategy(root);
    mkdirSync(path.join(root, "scratch", "nested"), { recursive: true });
    mkdirSync(path.join(root, "sibling"), { recursive: true });
    writeFileSync(path.join(root, "scratch", "nested", "file.txt"), "created");
    writeFileSync(path.join(root, "sibling", "file.txt"), "safe");

    strategy.deleteCreatedPath("scratch");

    assert.equal(existsSync(path.join(root, "scratch")), false);
    assert.equal(readFileSync(path.join(root, "sibling", "file.txt"), "utf8"), "safe");
  });
});
