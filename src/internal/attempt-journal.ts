import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import path from "node:path";

import type {
  Checkpoint,
  CheckpointId,
  DirtyEntry,
  GitIndexEntry,
  RecoverableAttempt,
  StatLedgerEntry,
  StorageStrategyKind,
} from "../types.js";
import type { StoredCheckpoint } from "./checkpoint-store.js";
import type { StorageBackupRecord } from "./storage-strategy.js";
import { isPathInsideRoot } from "./path.js";

export const ATTEMPT_JOURNAL_VERSION = 1;
export const ATTEMPT_JOURNAL_FILE_NAME = "journal.json";
export const BACKUP_MANIFEST_FILE_NAME = "backups.json";

export interface AttemptJournalAdapter {
  existsSync(targetPath: string): boolean;
  mkdirSync(targetPath: string, options: { recursive: true }): void;
  readdirSync(targetPath: string, options: { withFileTypes: true }): Dirent[];
  readFileSync(targetPath: string, encoding: BufferEncoding): string;
  writeFileSync(targetPath: string, data: string, encoding: BufferEncoding): void;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(targetPath: string, options: { force?: boolean }): void;
  now(): number;
}

export interface AttemptJournalEntry {
  schemaVersion: 1;
  checkpointId: CheckpointId;
  sessionId: string;
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  strategy: StorageStrategyKind;
  status: Checkpoint["status"];
  gitHead?: string;
  ignoredPatterns: string[];
  baseline: {
    gitAvailable: boolean;
    capturedAt: number;
    gitIndexEntries: GitIndexEntry[];
    statEntries: StatLedgerEntry[];
  };
  dirty: Array<{
    relativePath: string;
    kind: DirtyEntry["kind"];
    fileType: DirtyEntry["fileType"];
    capturedBy: DirtyEntry["capturedBy"];
    firstSeenAt: number;
    lastSeenAt: number;
  }>;
}

export interface WriteAttemptJournalInput {
  checkpoint: StoredCheckpoint;
  strategy: StorageStrategyKind;
  sessionId: string;
  workspaceRoot: string;
}

export interface BackupManifestEntry {
  schemaVersion: 1;
  checkpointId: CheckpointId;
  updatedAt: number;
  records: StorageBackupRecord[];
}

const nodeAttemptJournalAdapter: AttemptJournalAdapter = {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  now: Date.now,
};

export class AttemptJournalStore {
  private readonly sessionRoot: string;
  private readonly adapter: AttemptJournalAdapter;

  public constructor(options: {
    sessionRoot: string;
    adapter?: AttemptJournalAdapter;
  }) {
    this.sessionRoot = path.resolve(options.sessionRoot);
    this.adapter = options.adapter ?? nodeAttemptJournalAdapter;
  }

  public write(input: WriteAttemptJournalInput): void {
    const journalPath = this.getJournalPath(input.checkpoint.id);
    const journalDir = path.dirname(journalPath);
    const tempPath = path.join(
      journalDir,
      `.hyperion-journal-${input.checkpoint.id}-${process.pid}.tmp`,
    );

    this.adapter.mkdirSync(journalDir, { recursive: true });
    this.adapter.writeFileSync(
      tempPath,
      `${JSON.stringify(this.createEntry(input), null, 2)}\n`,
      "utf8",
    );

    try {
      this.adapter.renameSync(tempPath, journalPath);
    } catch (error) {
      try {
        this.adapter.rmSync(tempPath, { force: true });
      } catch {
        // Best-effort cleanup of failed atomic journal temp writes.
      }

      throw error;
    }
  }

  public writeBestEffort(input: WriteAttemptJournalInput): void {
    try {
      this.write(input);
    } catch {
      // Journals improve crash inspection but must not mask primary SDK behavior.
    }
  }

  public writeBackups(checkpointId: CheckpointId, records: StorageBackupRecord[]): void {
    const backupPath = this.getBackupManifestPath(checkpointId);
    const backupDir = path.dirname(backupPath);
    const tempPath = path.join(
      backupDir,
      `.hyperion-backups-${checkpointId}-${process.pid}.tmp`,
    );
    const manifest: BackupManifestEntry = {
      schemaVersion: ATTEMPT_JOURNAL_VERSION,
      checkpointId,
      updatedAt: this.adapter.now(),
      records: records.map((record) => ({ ...record, volatile: record.volatile ?? false })),
    };

    this.adapter.mkdirSync(backupDir, { recursive: true });
    this.adapter.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    try {
      this.adapter.renameSync(tempPath, backupPath);
    } catch (error) {
      try {
        this.adapter.rmSync(tempPath, { force: true });
      } catch {
        // Best-effort cleanup of failed atomic backup manifest temp writes.
      }

      throw error;
    }
  }

  public writeBackupsBestEffort(
    checkpointId: CheckpointId,
    records: StorageBackupRecord[],
  ): void {
    try {
      this.writeBackups(checkpointId, records);
    } catch {
      // Backup manifests are recovery metadata and must not mask mutation behavior.
    }
  }

  public recover(): RecoverableAttempt[] {
    if (!this.adapter.existsSync(this.sessionRoot)) {
      return [];
    }

    const attempts: RecoverableAttempt[] = [];

    for (const entry of this.safeReadDirectory(this.sessionRoot)) {
      if (!entry.isDirectory()) {
        continue;
      }

      const journalPath = path.join(this.sessionRoot, entry.name, ATTEMPT_JOURNAL_FILE_NAME);
      if (!isPathInsideRoot(this.sessionRoot, journalPath)) {
        continue;
      }

      const journal = this.readJournal(journalPath);
      if (!journal) {
        continue;
      }

      const backupManifest = this.readBackupManifest(this.getBackupManifestPath(journal.checkpointId));
      const rehydrationStatus = this.getRehydrationStatus(journal, backupManifest);

      const attempt: RecoverableAttempt = {
        checkpointId: journal.checkpointId,
        sessionId: journal.sessionId,
        createdAt: journal.createdAt,
        updatedAt: journal.updatedAt,
        status: journal.status,
        strategy: journal.strategy,
        dirtyCount: journal.dirty.length,
        journalPath,
        canRehydrate: rehydrationStatus.canRehydrate,
      };

      if (rehydrationStatus.reason) {
        attempt.nonRehydratableReason = rehydrationStatus.reason;
      }

      if (journal.gitHead) {
        attempt.gitHead = journal.gitHead;
      }

      attempts.push(attempt);
    }

    return attempts.sort((first, second) => first.createdAt - second.createdAt);
  }

  public getJournalPath(checkpointId: CheckpointId): string {
    return path.join(this.sessionRoot, checkpointId, ATTEMPT_JOURNAL_FILE_NAME);
  }

  public getBackupManifestPath(checkpointId: CheckpointId): string {
    return path.join(this.sessionRoot, checkpointId, BACKUP_MANIFEST_FILE_NAME);
  }

  public read(checkpointId: CheckpointId): AttemptJournalEntry | undefined {
    return this.readJournal(this.getJournalPath(checkpointId));
  }

  public readBackups(checkpointId: CheckpointId): BackupManifestEntry | undefined {
    return this.readBackupManifest(this.getBackupManifestPath(checkpointId));
  }

  private createEntry(input: WriteAttemptJournalInput): AttemptJournalEntry {
    const { checkpoint } = input;
    const entry: AttemptJournalEntry = {
      schemaVersion: ATTEMPT_JOURNAL_VERSION,
      checkpointId: checkpoint.id,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      createdAt: checkpoint.createdAt,
      updatedAt: this.adapter.now(),
      strategy: input.strategy,
      status: checkpoint.status,
      ignoredPatterns: [...checkpoint.baseline.ignoredPatterns],
      baseline: {
        gitAvailable: checkpoint.baseline.gitAvailable,
        capturedAt: checkpoint.baseline.capturedAt,
        gitIndexEntries: [...checkpoint.baseline.gitIndexEntries.values()],
        statEntries: [...checkpoint.baseline.statEntries.values()],
      },
      dirty: [...checkpoint.dirty.values()].map((dirtyEntry) => ({
        relativePath: dirtyEntry.relativePath,
        kind: dirtyEntry.kind,
        fileType: dirtyEntry.fileType,
        capturedBy: dirtyEntry.capturedBy,
        firstSeenAt: dirtyEntry.firstSeenAt,
        lastSeenAt: dirtyEntry.lastSeenAt,
      })),
    };

    if (checkpoint.baseline.gitHead) {
      entry.gitHead = checkpoint.baseline.gitHead;
    }

    return entry;
  }

  private readJournal(journalPath: string): AttemptJournalEntry | undefined {
    try {
      const parsed = JSON.parse(this.adapter.readFileSync(journalPath, "utf8")) as unknown;
      return isAttemptJournalEntry(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private readBackupManifest(backupPath: string): BackupManifestEntry | undefined {
    try {
      const parsed = JSON.parse(this.adapter.readFileSync(backupPath, "utf8")) as unknown;
      return isBackupManifestEntry(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private getRehydrationStatus(
    journal: AttemptJournalEntry,
    backupManifest: BackupManifestEntry | undefined,
  ): { canRehydrate: boolean; reason?: string } {
    if (journal.status === "disposed") {
      return { canRehydrate: false, reason: "checkpoint is disposed" };
    }

    if (journal.status === "promoted") {
      return { canRehydrate: false, reason: "checkpoint is promoted" };
    }

    const requiresBackups = journal.dirty.filter((entry) =>
      entry.kind === "modified" || entry.kind === "deleted" || entry.kind === "metadata",
    );

    if (requiresBackups.length === 0) {
      return { canRehydrate: true };
    }

    if (!backupManifest) {
      return { canRehydrate: false, reason: "backup manifest is missing" };
    }

    const recordsByPath = new Map(
      backupManifest.records.map((record) => [record.relativePath, record]),
    );

    for (const dirtyEntry of requiresBackups) {
      const record = recordsByPath.get(dirtyEntry.relativePath);

      if (!record) {
        return { canRehydrate: false, reason: `missing backup record for ${dirtyEntry.relativePath}` };
      }

      if (record.volatile) {
        return { canRehydrate: false, reason: `backup is volatile for ${dirtyEntry.relativePath}` };
      }

      if (record.kind === "file" && (!record.backupPath || !this.adapter.existsSync(record.backupPath))) {
        return { canRehydrate: false, reason: `backup file is missing for ${dirtyEntry.relativePath}` };
      }
    }

    return { canRehydrate: true };
  }

  private safeReadDirectory(directoryPath: string): Dirent[] {
    try {
      return this.adapter.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      return [];
    }
  }
}

function isAttemptJournalEntry(value: unknown): value is AttemptJournalEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AttemptJournalEntry>;

  return (
    candidate.schemaVersion === ATTEMPT_JOURNAL_VERSION &&
    typeof candidate.checkpointId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.workspaceRoot === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    (candidate.status === "active" ||
      candidate.status === "rolling-back" ||
      candidate.status === "disposed" ||
      candidate.status === "promoted") &&
    (candidate.strategy === "tmpfs" ||
      candidate.strategy === "posix-link" ||
      candidate.strategy === "pure-manifest") &&
    Array.isArray(candidate.ignoredPatterns) &&
    !!candidate.baseline &&
    typeof candidate.baseline === "object" &&
    Array.isArray(candidate.baseline.gitIndexEntries) &&
    Array.isArray(candidate.baseline.statEntries) &&
    Array.isArray(candidate.dirty)
  );
}

function isBackupManifestEntry(value: unknown): value is BackupManifestEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<BackupManifestEntry>;

  return (
    candidate.schemaVersion === ATTEMPT_JOURNAL_VERSION &&
    typeof candidate.checkpointId === "string" &&
    typeof candidate.updatedAt === "number" &&
    Array.isArray(candidate.records)
  );
}
