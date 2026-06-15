import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { PureManifestStrategy } from "../src/internal/pure-manifest-strategy.js";
import { createCheckpointStorage } from "../src/internal/storage-factory.js";
import { TmpfsDirtySetStrategy } from "../src/internal/tmpfs-dirty-set-strategy.js";
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
  });

  it("routes non-tmpfs selected strategies to Pure Manifest for this phase", () => {
    const workspaceRoot = createTempRoot("hyperion-storage-factory-workspace-");
    const pureManifestStorage = createCheckpointStorage(
      createStorageOptions(workspaceRoot, "pure-manifest"),
    );
    const posixLinkStorage = createCheckpointStorage(
      createStorageOptions(workspaceRoot, "posix-link"),
    );

    assert.equal(pureManifestStorage instanceof PureManifestStrategy, true);
    assert.equal(posixLinkStorage instanceof PureManifestStrategy, true);
    assert.equal(posixLinkStorage instanceof TmpfsDirtySetStrategy, false);
  });
});
