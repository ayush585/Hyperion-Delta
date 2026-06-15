export type StorageBackupKind = "file" | "directory" | "symlink" | "missing";

export interface StorageBackupRecord {
  relativePath: string;
  kind: StorageBackupKind;
  backupPath?: string;
  mode?: number;
  linkTarget?: string;
}

export interface StorageRestoreResult {
  relativePath: string;
  restored: boolean;
  deleted: boolean;
}

export interface StorageStrategy {
  backupFile(pathOrPathLike: string): StorageBackupRecord;
  restoreFile(pathOrPathLike: string): StorageRestoreResult;
  deleteCreatedPath(pathOrPathLike: string): void;
  getBackupRecord(pathOrPathLike: string): StorageBackupRecord | undefined;
  cleanup?(): void;
}
