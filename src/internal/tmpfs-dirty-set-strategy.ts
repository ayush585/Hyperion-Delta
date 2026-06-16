import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { PureManifestStrategy } from "./pure-manifest-strategy.js";
import { isPathInsideRoot } from "./path.js";

const DEFAULT_TMPFS_ROOT = "/dev/shm/hyperion-delta";

export interface TmpfsDirtySetStrategyOptions {
  workspaceRoot: string;
  sessionId: string;
  checkpointId: string;
  tmpfsRoot?: string;
}

export class TmpfsDirtySetStrategy extends PureManifestStrategy {
  public readonly backupNamespace: string;
  private readonly tmpfsRoot: string;

  public constructor(options: TmpfsDirtySetStrategyOptions) {
    const tmpfsRoot = path.resolve(options.tmpfsRoot ?? DEFAULT_TMPFS_ROOT);
    const backupNamespace = path.join(
      tmpfsRoot,
      options.sessionId,
      options.checkpointId,
    );
    mkdirSync(backupNamespace, { recursive: true });
    super(options.workspaceRoot, backupNamespace);
    this.backupNamespace = backupNamespace;
    this.tmpfsRoot = tmpfsRoot;
  }

  public override cleanup(): void {
    try {
      if (
        this.backupNamespace !== this.tmpfsRoot &&
        isPathInsideRoot(this.tmpfsRoot, this.backupNamespace)
      ) {
        rmSync(this.backupNamespace, { recursive: true, force: true });
      }
    } catch {
      // Cleanup is best-effort and must never risk user workspace integrity.
    }
  }

  public override getDiagnostics() {
    return {
      ...super.getDiagnostics(),
      physicalStrategy: "tmpfs" as const,
      tmpfs: {
        active: true,
      },
    };
  }
}

export { DEFAULT_TMPFS_ROOT };
