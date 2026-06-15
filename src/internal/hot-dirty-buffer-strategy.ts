import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { HyperionIntegrityError } from "../errors.js";
import { normalizeWorkspacePath } from "./path.js";
import type {
  StorageBackupRecord,
  StorageRestoreResult,
  StorageStrategy,
} from "./storage-strategy.js";

export interface HotDirtyBufferOptions {
  workspaceRoot: string;
  delegate: StorageStrategy;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export interface HotDirtyBufferDiagnostics {
  memoryHits: number;
  spills: number;
  bytesUsed: number;
  filesUsed: number;
}

interface MemoryBackupRecord extends StorageBackupRecord {
  contents: Buffer;
}

export class HotDirtyBufferStrategy implements StorageStrategy {
  private readonly memoryRecords = new Map<string, MemoryBackupRecord>();
  private bytesUsed = 0;
  private memoryHits = 0;
  private spills = 0;

  public constructor(private readonly options: HotDirtyBufferOptions) {}

  public backupFile(pathOrPathLike: string): StorageBackupRecord {
    const relativePath = normalizeWorkspacePath(this.options.workspaceRoot, pathOrPathLike);
    const existingMemoryRecord = this.memoryRecords.get(relativePath);

    if (existingMemoryRecord) {
      return toPublicRecord(existingMemoryRecord);
    }

    const existingDelegateRecord = this.options.delegate.getBackupRecord(relativePath);

    if (existingDelegateRecord) {
      return existingDelegateRecord;
    }

    const sourcePath = this.toWorkspacePath(relativePath);

    if (!existsSync(sourcePath)) {
      return this.options.delegate.backupFile(relativePath);
    }

    const sourceStat = lstatSync(sourcePath);

    if (!sourceStat.isFile()) {
      return this.options.delegate.backupFile(relativePath);
    }

    if (!this.canStore(sourceStat.size)) {
      this.spills += 1;
      return this.options.delegate.backupFile(relativePath);
    }

    const contents = readFileSync(sourcePath);
    const record: MemoryBackupRecord = {
      relativePath,
      kind: "file",
      mode: sourceStat.mode,
      contents,
    };

    this.memoryRecords.set(relativePath, record);
    this.bytesUsed += contents.byteLength;
    this.memoryHits += 1;

    return toPublicRecord(record);
  }

  public restoreFile(pathOrPathLike: string): StorageRestoreResult {
    const relativePath = normalizeWorkspacePath(this.options.workspaceRoot, pathOrPathLike);
    const memoryRecord = this.memoryRecords.get(relativePath);

    if (!memoryRecord) {
      return this.options.delegate.restoreFile(relativePath);
    }

    const targetPath = this.toWorkspacePath(relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    const tempPath = path.join(
      path.dirname(targetPath),
      `.hyperion-${path.basename(targetPath)}-${randomUUID()}.tmp`,
    );

    try {
      writeFileSync(tempPath, memoryRecord.contents);
      restoreMode(tempPath, memoryRecord.mode);
      renameSync(tempPath, targetPath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error instanceof Error
        ? error
        : new HyperionIntegrityError(`Unable to restore ${relativePath}`);
    }

    return { relativePath, restored: true, deleted: false };
  }

  public deleteCreatedPath(pathOrPathLike: string): void {
    this.options.delegate.deleteCreatedPath(pathOrPathLike);
  }

  public getBackupRecord(pathOrPathLike: string): StorageBackupRecord | undefined {
    const relativePath = normalizeWorkspacePath(this.options.workspaceRoot, pathOrPathLike);
    const memoryRecord = this.memoryRecords.get(relativePath);

    if (memoryRecord) {
      return toPublicRecord(memoryRecord);
    }

    return this.options.delegate.getBackupRecord(relativePath);
  }

  public cleanup(): void {
    this.memoryRecords.clear();
    this.bytesUsed = 0;
    this.options.delegate.cleanup?.();
  }

  public getDiagnosticsForTests(): HotDirtyBufferDiagnostics {
    return {
      memoryHits: this.memoryHits,
      spills: this.spills,
      bytesUsed: this.bytesUsed,
      filesUsed: this.memoryRecords.size,
    };
  }

  private canStore(size: number): boolean {
    if (size > this.options.maxFileBytes) {
      return false;
    }

    if (this.memoryRecords.size >= this.options.maxFiles) {
      return false;
    }

    return this.bytesUsed + size <= this.options.maxTotalBytes;
  }

  private toWorkspacePath(relativePath: string): string {
    return path.join(this.options.workspaceRoot, ...relativePath.split("/"));
  }
}

function toPublicRecord(record: MemoryBackupRecord): StorageBackupRecord {
  const publicRecord: StorageBackupRecord = {
    relativePath: record.relativePath,
    kind: record.kind,
  };

  if (record.mode !== undefined) {
    publicRecord.mode = record.mode;
  }

  return publicRecord;
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
