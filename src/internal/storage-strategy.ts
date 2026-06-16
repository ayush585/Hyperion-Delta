export type StorageBackupKind = "file" | "directory" | "symlink" | "missing";

export interface StorageBackupRecord {
  relativePath: string;
  kind: StorageBackupKind;
  backupPath?: string;
  mode?: number;
  linkTarget?: string;
  volatile?: boolean;
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
  getBackupRecords(): StorageBackupRecord[];
  readBackupFile(pathOrPathLike: string): Buffer | undefined;
  hydrateBackupRecords?(records: StorageBackupRecord[]): void;
  cleanup?(): void;
}
