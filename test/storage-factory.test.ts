import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { PosixLinkStrategy } from "../src/internal/posix-link-strategy.js";
import { PureManifestStrategy } from "../src/internal/pure-manifest-strategy.js";
import { createCheckpointStorage } from "../src/internal/storage-factory.js";
import { TmpfsDirtySetStrategy } from "../src/internal/tmpfs-dirty-set-strategy.js";
import { HotDirtyBufferStrategy } from "../src/internal/hot-dirty-buffer-strategy.js";
import { NtfsLinkStrategy } from "../src/internal/ntfs-link-strategy.js";
import type { StorageStrategyKind } from "../src/index.js";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createStorageOptions(
  workspaceRoot: string,
  selectedKind: StorageStrategyKind,
  tmpfsRoot?: string,
) {
  return {
    workspaceRoot,
    selectedKind,
    checkpointNamespace: path.join(workspaceRoot, ".hyperion", "checkpoints", "checkpoint-1"),
    checkpointId: "checkpoint-1",
    sessionId: "session-1",
    useHotBuffer: false,
    hotBufferMaxFileBytes: 256 * 1024,
    hotBufferMaxTotalBytes: 8 * 1024 * 1024,
    hotBufferMaxFiles: 1024,
    ...(tmpfsRoot ? { tmpfsRoot } : {}),
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("createCheckpointStorage", () => {
  it("creates tmpfs storage when tmpfs is selected and namespace setup succeeds", () => {
    const workspaceRoot = createTempRoot("hyperion-storage-factory-workspace-");
    const tmpfsRoot = createTempRoot("hyperion-storage-factory-tmpfs-");

    const storage = createCheckpointStorage(
      createStorageOptions(workspaceRoot, "tmpfs", tmpfsRoot),
    );

    assert.equal(storage instanceof TmpfsDirtySetStrategy, true);
    assert.equal(storage.getDiagnostics().physicalStrategy, "tmpfs");
    assert.equal(storage.getDiagnostics().tmpfs?.active, true);
  });

  it("falls back to Pure Manifest when tmpfs namespace setup fails", () => {
    const workspaceRoot = createTempRoot("hyperion-storage-factory-workspace-");
    const tmpfsFile = path.join(workspaceRoot, "not-a-directory");
    writeFileSync(tmpfsFile, "file");

    const storage = createCheckpointStorage(
      createStorageOptions(workspaceRoot, "tmpfs", tmpfsFile),
    );

    assert.equal(storage instanceof PureManifestStrategy, true);
    assert.equal(storage instanceof TmpfsDirtySetStrategy, false);
    assert.equal(storage.getDiagnostics().physicalStrategy, "pure-manifest");
  });

  it("routes Pure Manifest selections to Pure Manifest storage", () => {
    const workspaceRoot = createTempRoot("hyperion-storage-factory-workspace-");
    const pureManifestStorage = createCheckpointStorage(
      createStorageOptions(workspaceRoot, "pure-manifest"),
    );

    assert.equal(pureManifestStorage instanceof PureManifestStrategy, true);
    assert.equal(pureManifestStorage.getDiagnostics().physicalStrategy, "pure-manifest");
  });

  it("routes posix-link selections to POSIX link storage", () => {
    const workspaceRoot = createTempRoot("hyperion-storage-factory-workspace-");
    const posixLinkStorage = createCheckpointStorage(
      createStorageOptions(workspaceRoot, "posix-link"),
    );

    assert.equal(posixLinkStorage instanceof PosixLinkStrategy, true);
    assert.equal(posixLinkStorage instanceof PureManifestStrategy, true);
    assert.equal(posixLinkStorage instanceof TmpfsDirtySetStrategy, false);
    assert.equal(posixLinkStorage.getDiagnostics().physicalStrategy, "posix-link");
    assert.equal(typeof posixLinkStorage.getDiagnostics().posixLink?.linkModeActive, "boolean");
  });

  it("routes ntfs-link selections to NTFS link storage", () => {
    const workspaceRoot = createTempRoot("hyperion-storage-factory-workspace-");
    const ntfsLinkStorage = createCheckpointStorage(
      createStorageOptions(workspaceRoot, "ntfs-link"),
    );

    assert.equal(ntfsLinkStorage instanceof NtfsLinkStrategy, true);
    assert.equal(ntfsLinkStorage instanceof PureManifestStrategy, true);
    assert.equal(ntfsLinkStorage instanceof TmpfsDirtySetStrategy, false);
    assert.equal(ntfsLinkStorage.getDiagnostics().physicalStrategy, "ntfs-link");
    assert.equal(typeof ntfsLinkStorage.getDiagnostics().ntfsLink?.linkModeActive, "boolean");
  });

  it("wraps selected storage in the Hot Dirty Buffer when enabled", () => {
    const workspaceRoot = createTempRoot("hyperion-storage-factory-workspace-");
    const storage = createCheckpointStorage({
      ...createStorageOptions(workspaceRoot, "pure-manifest"),
      useHotBuffer: true,
    });

    assert.equal(storage instanceof HotDirtyBufferStrategy, true);
    assert.equal(storage.getDiagnostics().hotBuffer.enabled, true);
    assert.equal(storage.getDiagnostics().physicalStrategy, "pure-manifest");
  });
});
