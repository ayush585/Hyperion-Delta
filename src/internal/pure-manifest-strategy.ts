import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { HyperionIntegrityError } from "../errors.js";
import { normalizeWorkspacePath } from "./path.js";
import type {
  StorageBackupRecord,
  StorageRestoreResult,
  StorageStrategy,
} from "./storage-strategy.js";

export class PureManifestStrategy implements StorageStrategy {
  protected readonly backupRecords = new Map<string, StorageBackupRecord>();

  public constructor(
    protected readonly workspaceRoot: string,
    protected readonly storageNamespace: string,
  ) {}

  public backupFile(pathOrPathLike: string): StorageBackupRecord {
    const relativePath = normalizeWorkspacePath(this.workspaceRoot, pathOrPathLike);
    const existingRecord = this.backupRecords.get(relativePath);

    if (existingRecord) {
      return existingRecord;
    }

    const sourcePath = this.toWorkspacePath(relativePath);

    if (!existsSync(sourcePath)) {
      return this.setRecord({
        relativePath,
        kind: "missing",
      });
    }

    const sourceStat = lstatSync(sourcePath);

    if (sourceStat.isSymbolicLink()) {
      return this.setRecord({
        relativePath,
        kind: "symlink",
        mode: sourceStat.mode,
        linkTarget: readlinkSync(sourcePath),
      });
    }

    if (sourceStat.isDirectory()) {
      return this.setRecord({
        relativePath,
        kind: "directory",
        mode: sourceStat.mode,
      });
    }

    return this.backupRegularFile(relativePath, sourcePath, sourceStat.mode);
  }

  public restoreFile(pathOrPathLike: string): StorageRestoreResult {
    const relativePath = normalizeWorkspacePath(this.workspaceRoot, pathOrPathLike);
    const record = this.requireRecord(relativePath);

    if (record.kind === "missing") {
      this.deleteCreatedPath(relativePath);
      return { relativePath, restored: false, deleted: true };
    }

    if (record.kind === "directory") {
      const targetPath = this.toWorkspacePath(relativePath);
      mkdirSync(targetPath, { recursive: true });
      restoreMode(targetPath, record.mode);
      return { relativePath, restored: true, deleted: false };
    }

    if (record.kind === "symlink") {
      return this.restoreSymlink(record);
    }

    return this.restoreRegularFile(record);
  }

  public deleteCreatedPath(pathOrPathLike: string): void {
    const relativePath = normalizeWorkspacePath(this.workspaceRoot, pathOrPathLike);
    const targetPath = this.toWorkspacePath(relativePath);

    rmSync(targetPath, { recursive: true, force: true });
  }

  public getBackupRecord(pathOrPathLike: string): StorageBackupRecord | undefined {
    const relativePath = normalizeWorkspacePath(this.workspaceRoot, pathOrPathLike);
    return this.backupRecords.get(relativePath);
  }

  public cleanup(): void {
    // Pure Manifest storage is project-local for now; lifecycle GC owns persistent cleanup.
  }

  protected backupRegularFile(
    relativePath: string,
    sourcePath: string,
    mode: number,
  ): StorageBackupRecord {
    const backupPath = this.toBackupPath(relativePath);
    mkdirSync(path.dirname(backupPath), { recursive: true });
    copyFileSync(sourcePath, backupPath);

    return this.setRecord({
      relativePath,
      kind: "file",
      backupPath,
      mode,
    });
  }

  private restoreRegularFile(record: StorageBackupRecord): StorageRestoreResult {
    if (!record.backupPath || !existsSync(record.backupPath)) {
      throw new HyperionIntegrityError(`Missing backup for ${record.relativePath}`);
    }

    const targetPath = this.toWorkspacePath(record.relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });

    const tempPath = path.join(
      path.dirname(targetPath),
      `.hyperion-${path.basename(targetPath)}-${randomUUID()}.tmp`,
    );

    try {
      copyFileSync(record.backupPath, tempPath);
      restoreMode(tempPath, record.mode);
      renameSync(tempPath, targetPath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }

    return { relativePath: record.relativePath, restored: true, deleted: false };
  }

  private restoreSymlink(record: StorageBackupRecord): StorageRestoreResult {
    if (!record.linkTarget) {
      throw new HyperionIntegrityError(`Missing symlink target for ${record.relativePath}`);
    }

    const targetPath = this.toWorkspacePath(record.relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    rmSync(targetPath, { recursive: true, force: true });

    try {
      symlinkSync(record.linkTarget, targetPath);
    } catch (error) {
      throw new HyperionIntegrityError(
        `Unable to restore symlink ${record.relativePath}: ${String(error)}`,
      );
    }

    return { relativePath: record.relativePath, restored: true, deleted: false };
  }

  private requireRecord(relativePath: string): StorageBackupRecord {
    const record = this.backupRecords.get(relativePath);

    if (!record) {
      throw new HyperionIntegrityError(`No backup record for ${relativePath}`);
    }

    return record;
  }

  protected setRecord(record: StorageBackupRecord): StorageBackupRecord {
    this.backupRecords.set(record.relativePath, record);
    return record;
  }

  protected toWorkspacePath(relativePath: string): string {
    return path.join(this.workspaceRoot, ...relativePath.split("/"));
  }

  protected toBackupPath(relativePath: string): string {
    return path.join(this.storageNamespace, "files", ...relativePath.split("/"));
  }
}

function restoreMode(targetPath: string, mode: number | undefined): void {
  if (mode === undefined) {
    return;
  }

  try {
    chmodSync(targetPath, mode);
  } catch {
    // Mode restoration is best-effort across Windows and restricted filesystems.
  }
}
