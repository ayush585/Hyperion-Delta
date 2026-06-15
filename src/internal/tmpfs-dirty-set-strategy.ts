import { mkdirSync } from "node:fs";
import path from "node:path";

import { PureManifestStrategy } from "./pure-manifest-strategy.js";

const DEFAULT_TMPFS_ROOT = "/dev/shm/hyperion-delta";

export interface TmpfsDirtySetStrategyOptions {
  workspaceRoot: string;
  sessionId: string;
  checkpointId: string;
  tmpfsRoot?: string;
}

export class TmpfsDirtySetStrategy extends PureManifestStrategy {
  public readonly backupNamespace: string;

  public constructor(options: TmpfsDirtySetStrategyOptions) {
    const backupNamespace = path.join(
      options.tmpfsRoot ?? DEFAULT_TMPFS_ROOT,
      options.sessionId,
      options.checkpointId,
    );
    mkdirSync(backupNamespace, { recursive: true });
    super(options.workspaceRoot, backupNamespace);
    this.backupNamespace = backupNamespace;
  }
}

export { DEFAULT_TMPFS_ROOT };
