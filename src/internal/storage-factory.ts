import { PosixLinkStrategy } from "./posix-link-strategy.js";
import { PureManifestStrategy } from "./pure-manifest-strategy.js";
import type { StorageStrategy } from "./storage-strategy.js";
import { TmpfsDirtySetStrategy } from "./tmpfs-dirty-set-strategy.js";
import type { StorageStrategyKind } from "../types.js";

export interface CreateCheckpointStorageOptions {
  workspaceRoot: string;
  selectedKind: StorageStrategyKind;
  checkpointNamespace: string;
  checkpointId: string;
  sessionId: string;
  tmpfsRoot?: string;
}

export function createCheckpointStorage(
  options: CreateCheckpointStorageOptions,
): StorageStrategy {
  if (options.selectedKind === "tmpfs") {
    try {
      const tmpfsOptions = {
        workspaceRoot: options.workspaceRoot,
        sessionId: options.sessionId,
        checkpointId: options.checkpointId,
        ...(options.tmpfsRoot ? { tmpfsRoot: options.tmpfsRoot } : {}),
      };
      return new TmpfsDirtySetStrategy(tmpfsOptions);
    } catch {
      return createPureManifestStorage(options);
    }
  }

  if (options.selectedKind === "posix-link") {
    return new PosixLinkStrategy(options.workspaceRoot, options.checkpointNamespace);
  }

  return createPureManifestStorage(options);
}

function createPureManifestStorage(options: CreateCheckpointStorageOptions): PureManifestStrategy {
  return new PureManifestStrategy(options.workspaceRoot, options.checkpointNamespace);
}
