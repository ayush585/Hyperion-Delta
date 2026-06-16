import { copyFileSync, linkSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { PureManifestStrategy } from "./pure-manifest-strategy.js";
import type { StorageBackupRecord } from "./storage-strategy.js";

export interface NtfsLinkStrategyAdapter {
  linkSync(sourcePath: string, backupPath: string): void;
  copyFileSync(sourcePath: string, targetPath: string): void;
  renameSync(sourcePath: string, targetPath: string): void;
  rmSync(targetPath: string, options: { force?: boolean; recursive?: boolean }): void;
  mkdirSync(targetPath: string, options: { recursive?: boolean }): void;
}

const nodeNtfsLinkStrategyAdapter: NtfsLinkStrategyAdapter = {
  linkSync,
  copyFileSync,
  renameSync,
  rmSync,
  mkdirSync,
};

export interface NtfsLinkStrategyOptions {
  adapter?: NtfsLinkStrategyAdapter;
}

export class NtfsLinkStrategy extends PureManifestStrategy {
  private readonly adapter: NtfsLinkStrategyAdapter;
  private linksUnsafe = false;

  public constructor(
    workspaceRoot: string,
    storageNamespace: string,
    options: NtfsLinkStrategyOptions = {},
  ) {
    super(workspaceRoot, storageNamespace);
    this.adapter = options.adapter ?? nodeNtfsLinkStrategyAdapter;
  }

  public get isLinkModeActive(): boolean {
    return !this.linksUnsafe;
  }

  public override getDiagnostics() {
    return {
      ...super.getDiagnostics(),
      physicalStrategy: "ntfs-link" as const,
      ntfsLink: {
        linkModeActive: this.isLinkModeActive,
      },
    };
  }

  protected override backupRegularFile(
    relativePath: string,
    sourcePath: string,
    mode: number,
  ): StorageBackupRecord {
    if (this.linksUnsafe) {
      return super.backupRegularFile(relativePath, sourcePath, mode);
    }

    const backupPath = this.toBackupPath(relativePath);

    try {
      this.adapter.mkdirSync(path.dirname(backupPath), { recursive: true });
      this.adapter.linkSync(sourcePath, backupPath);
      this.materializeWorkspaceTarget(sourcePath);

      return this.setRecord({
        relativePath,
        kind: "file",
        backupPath,
        mode,
      });
    } catch {
      this.linksUnsafe = true;
      this.adapter.rmSync(backupPath, { force: true });
      return super.backupRegularFile(relativePath, sourcePath, mode);
    }
  }

  private materializeWorkspaceTarget(sourcePath: string): void {
    const tempPath = path.join(
      path.dirname(sourcePath),
      `.hyperion-ntfs-link-${path.basename(sourcePath)}-${randomUUID()}.tmp`,
    );

    try {
      this.adapter.copyFileSync(sourcePath, tempPath);
      this.adapter.renameSync(tempPath, sourcePath);
    } catch (error) {
      this.adapter.rmSync(tempPath, { force: true });
      throw error;
    }
  }
}
