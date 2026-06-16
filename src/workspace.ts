import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_HOT_BUFFER_MAX_FILE_BYTES,
  DEFAULT_HOT_BUFFER_MAX_FILES,
  DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES,
  DEFAULT_IGNORED_PATTERNS,
  DEFAULT_MAX_CONCURRENT_CHECKPOINTS,
} from "./constants.js";
import {
  HyperionError,
  HyperionIntegrityError,
  HyperionIgnoredPathError,
  HyperionPathError,
  HyperionRollbackError,
} from "./errors.js";
import {
  AttemptJournalStore,
  type AttemptJournalEntry,
  type BackupManifestEntry,
} from "./internal/attempt-journal.js";
import { CheckpointStore, type StoredCheckpoint } from "./internal/checkpoint-store.js";
import {
  discoverEnvironmentProfile,
  type EnvironmentProfile,
} from "./internal/environment.js";
import { GhostDirectoryCleaner } from "./internal/ghost-directory-cleaner.js";
import { createIgnoreMatcher, type IgnoreMatcher } from "./internal/ignore.js";
import { LifecycleCleanupRegistry } from "./internal/lifecycle.js";
import { PatchExportEngine } from "./internal/patch-export-engine.js";
import { isPathInsideRoot, normalizeWorkspacePath } from "./internal/path.js";
import { ReconciliationEngine } from "./internal/reconciliation-engine.js";
import { RollbackEngine } from "./internal/rollback-engine.js";
import { HyperionSessionManager } from "./internal/session-gc.js";
import {
  ensureSessionRoot,
  probeSessionDeviceInfo,
  type SessionDeviceInfo,
} from "./internal/session.js";
import { HybridStateEngine } from "./internal/state.js";
import {
  selectStorageStrategy,
  type StrategySelection,
} from "./internal/strategy.js";
import { createCheckpointStorage } from "./internal/storage-factory.js";
import type { StorageStrategy } from "./internal/storage-strategy.js";
import { VfsInterceptor, type VfsMutationRecord } from "./internal/vfs-interceptor.js";
import type {
  CheckpointId,
  DirtyEntry,
  HyperionConfig,
  HyperionPromoteOptions,
  HyperionPromotionResult,
  RecoverableAttempt,
  ReconcileResult,
  ResolvedHyperionConfig,
  StateManifest,
  StatLedgerEntry,
  StorageStrategyKind,
} from "./types.js";

interface IgnoredWriteEvent {
  relativePath: string;
  kind: VfsMutationRecord["kind"];
  capturedAt: number;
}

export class HyperionWorkspace {
  public readonly root: string;
  public readonly config: ResolvedHyperionConfig;

  private readonly ignoreMatcher: IgnoreMatcher;
  private environmentProfile: EnvironmentProfile;
  private strategySelection: StrategySelection;
  private readonly stateEngine: HybridStateEngine;
  private readonly checkpointStore: CheckpointStore;
  private readonly checkpointStorage = new Map<CheckpointId, StorageStrategy>();
  private readonly storageSessionId = randomUUID();
  private readonly attemptJournalStore: AttemptJournalStore;
  private readonly ignoredWriteEvents: IgnoredWriteEvent[] = [];
  private readonly sessionManager: HyperionSessionManager;
  private readonly patchExportEngine = new PatchExportEngine();
  private readonly rollbackEngine = new RollbackEngine();
  private readonly reconciliationEngine = new ReconciliationEngine();
  private readonly vfsInterceptor: VfsInterceptor;
  private readonly lifecycleCleanupRegistry = new LifecycleCleanupRegistry();
  private readonly manualTrackedPaths = new Set<string>();
  private readonly manualTrackedIgnoredPaths = new Set<string>();
  private sessionDeviceInfo?: SessionDeviceInfo;
  private emergencyCleanupCompleted = false;
  private disposed = false;

  public constructor(rootOrConfig: string | HyperionConfig) {
    const config = this.resolveConfig(rootOrConfig);
    this.root = config.workspaceRoot;
    this.config = config;
    this.ignoreMatcher = createIgnoreMatcher(config.ignoredPatterns);
    this.sessionManager = new HyperionSessionManager({
      workspaceRoot: this.root,
      sessionId: this.storageSessionId,
      shouldSkipWorkspacePath: (relativePath) => this.ignoreMatcher.matches(relativePath),
    });
    this.sessionManager.initialize();
    this.environmentProfile = discoverEnvironmentProfile({
      workspaceRoot: config.workspaceRoot,
      sessionRoot: config.sessionRoot,
    });
    this.strategySelection = selectStorageStrategy(config, this.environmentProfile);
    this.stateEngine = new HybridStateEngine(config, {
      gitAvailableHint: this.environmentProfile.gitAvailable,
    });
    this.checkpointStore = new CheckpointStore(config);
    this.attemptJournalStore = new AttemptJournalStore({
      sessionRoot: config.sessionRoot,
    });
    this.vfsInterceptor = new VfsInterceptor({
      beforeMutation: (records) => {
        this.recordVfsMutations(records);
      },
    });
    this.lifecycleCleanupRegistry.addCleanupCallback(() => {
      this.emergencyCleanupSync();
    });
    this.lifecycleCleanupRegistry.register();
  }

  public track(pathOrPaths: string | string[]): void {
    const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];

    if (paths.length === 0) {
      throw new HyperionPathError("track() requires at least one path");
    }

    for (const path of paths) {
      if (typeof path !== "string" || path.trim() === "") {
        throw new HyperionPathError("track() paths must be non-empty strings");
      }

      const relativePath = normalizeWorkspacePath(this.root, path);
      this.manualTrackedPaths.add(relativePath);
      if (this.ignoreMatcher.matches(relativePath)) {
        this.manualTrackedIgnoredPaths.add(relativePath);
      }
    }
  }

  public async snapshot(): Promise<CheckpointId> {
    this.assertNotDisposed("snapshot()");
    this.runCapacityGarbageCollection();
    this.checkpointStore.ensureCapacityAvailable();
    this.ensureSessionRoot();
    const deviceInfo = this.probeSessionDeviceInfo();
    this.refreshStrategySelection(deviceInfo);

    const baseline = this.stateEngine.captureManifest();
    const checkpoint = this.checkpointStore.createCheckpoint({
      baseline,
      deviceId: deviceInfo.workspaceDeviceId,
    });
    this.checkpointStorage.set(
      checkpoint.id,
      createCheckpointStorage({
        workspaceRoot: this.root,
        selectedKind: this.strategySelection.kind,
        checkpointNamespace: checkpoint.storageNamespace,
        checkpointId: checkpoint.id,
        sessionId: this.storageSessionId,
        useHotBuffer: this.config.useHotBuffer,
        hotBufferMaxFileBytes: this.config.hotBufferMaxFileBytes,
        hotBufferMaxTotalBytes: this.config.hotBufferMaxTotalBytes,
      hotBufferMaxFiles: this.config.hotBufferMaxFiles,
      }),
    );
    this.writeAttemptJournal(checkpoint);

    return checkpoint.id;
  }

  public async rollback(checkpointId: CheckpointId): Promise<void> {
    this.assertNotDisposed("rollback()");
    const checkpoint = this.requireActiveCheckpoint(checkpointId);
    const storage = this.requireCheckpointStorage(checkpointId);
    const ghostDirectoryCleaner = new GhostDirectoryCleaner({
      workspaceRoot: this.root,
      baseline: checkpoint.baseline,
      ignoreMatcher: this.ignoreMatcher,
    });

    try {
      this.writeAttemptJournalBestEffort(checkpoint);
      await this.rollbackEngine.rollback({
        checkpoint,
        storage,
        ghostDirectoryCleaner,
        reconcile: async () => {
          await this.reconcile(checkpointId);
        },
      });
      this.writeAttemptJournalBestEffort(checkpoint);
    } catch (error) {
      this.writeAttemptJournalBestEffort(checkpoint);
      throw error;
    }

    this.cleanupCheckpointStorage(checkpointId);
  }

  public async reconcile(checkpointId?: CheckpointId): Promise<ReconcileResult> {
    const checkpoint = checkpointId
      ? this.requireActiveCheckpoint(checkpointId)
      : this.checkpointStore.getMostRecentActiveCheckpoint();

    if (!checkpoint) {
      return {
        created: [],
        modified: [],
        deleted: [],
        renamed: [],
      };
    }

    const currentManifest = this.stateEngine.captureManifest();
    const result = this.reconciliationEngine.reconcile({ checkpoint, currentManifest });
    this.writeAttemptJournalBestEffort(checkpoint);
    return result;
  }

  public async dispose(): Promise<void> {
    this.markActiveAttemptJournalsDisposed();
    this.emergencyCleanupSync();
    this.checkpointStore.clear();
    this.lifecycleCleanupRegistry.unregister();
    this.disposed = true;
  }

  public async recoverAttempts(): Promise<RecoverableAttempt[]> {
    return this.config.durableAttemptJournals ? this.attemptJournalStore.recover() : [];
  }

  public async exportPatch(checkpointId: CheckpointId): Promise<string> {
    this.assertNotDisposed("exportPatch()");
    const checkpoint = this.requireActiveCheckpoint(checkpointId);
    const storage = this.requireCheckpointStorage(checkpointId);

    await this.reconcile(checkpointId);

    return this.patchExportEngine.exportPatch({
      workspaceRoot: this.root,
      checkpoint,
      storage,
    });
  }

  public async promote(
    checkpointId: CheckpointId,
    options: HyperionPromoteOptions = {},
  ): Promise<HyperionPromotionResult> {
    this.assertNotDisposed("promote()");
    const checkpoint = this.requireActiveCheckpoint(checkpointId);
    const storage = this.requireCheckpointStorage(checkpointId);

    if (checkpoint.lock.locked || checkpoint.status === "rolling-back") {
      throw new HyperionRollbackError(`Checkpoint is already locked: ${checkpointId}`);
    }

    checkpoint.lock.locked = true;

    try {
      const reconcileResult = await this.reconcile(checkpointId);
      const patch = options.exportPatch
        ? this.patchExportEngine.exportPatch({
            workspaceRoot: this.root,
            checkpoint,
            storage,
          })
        : undefined;
      const promotedAt = Date.now();

      checkpoint.status = "promoted";
      this.writeAttemptJournalBestEffort(checkpoint);

      const result: HyperionPromotionResult = {
        checkpointId,
        promotedAt,
        dirtyCount: checkpoint.dirty.size,
        reconcileResult,
        storageCleaned: this.cleanupCheckpointStorageBestEffortWithResult(checkpointId),
      };

      if (patch !== undefined) {
        result.patch = patch;
      }

      return result;
    } finally {
      checkpoint.lock.locked = false;
    }
  }

  public async rehydrateAttempt(checkpointId: CheckpointId): Promise<CheckpointId> {
    this.assertNotDisposed("rehydrateAttempt()");

    if (this.checkpointStore.getCheckpoint(checkpointId)) {
      return checkpointId;
    }

    const journal = this.attemptJournalStore.read(checkpointId);

    if (!journal) {
      throw new HyperionRollbackError(`Unknown recoverable checkpoint: ${checkpointId}`);
    }

    if (resolve(journal.workspaceRoot) !== this.root) {
      throw new HyperionPathError(`Recoverable checkpoint belongs to another workspace: ${checkpointId}`);
    }

    if (journal.status === "disposed") {
      throw new HyperionRollbackError(`Recoverable checkpoint is disposed: ${checkpointId}`);
    }

    if (journal.status === "promoted") {
      throw new HyperionRollbackError(`Recoverable checkpoint is promoted: ${checkpointId}`);
    }

    const backups = this.attemptJournalStore.readBackups(checkpointId);
    this.assertRehydratable(journal, backups);
    this.runCapacityGarbageCollection();
    this.checkpointStore.ensureCapacityAvailable();

    const checkpoint = this.checkpointStore.restoreCheckpoint({
      id: checkpointId,
      baseline: stateManifestFromJournal(journal),
      dirty: dirtyMapFromJournal(journal),
      storageNamespace: join(this.config.sessionRoot, checkpointId),
      status: journal.status === "rolling-back" ? "active" : journal.status,
      createdAt: journal.createdAt,
    });
    const storage = createCheckpointStorage({
      workspaceRoot: this.root,
      selectedKind: journal.strategy,
      checkpointNamespace: checkpoint.storageNamespace,
      checkpointId: checkpoint.id,
      sessionId: journal.sessionId,
      useHotBuffer: false,
      hotBufferMaxFileBytes: this.config.hotBufferMaxFileBytes,
      hotBufferMaxTotalBytes: this.config.hotBufferMaxTotalBytes,
      hotBufferMaxFiles: this.config.hotBufferMaxFiles,
    });

    storage.hydrateBackupRecords?.(backups?.records ?? []);
    this.checkpointStorage.set(checkpointId, storage);

    return checkpointId;
  }

  public installFsInterceptor(): void {
    if (this.disposed) {
      throw new HyperionError("Cannot install fs interceptor after dispose()");
    }

    this.vfsInterceptor.install();
  }

  public uninstallFsInterceptor(): void {
    this.vfsInterceptor.uninstall();
  }

  public get isFsInterceptorInstalled(): boolean {
    return this.vfsInterceptor.isInstalled;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public get strategy(): StorageStrategyKind {
    return this.strategySelection.kind;
  }

  private resolveConfig(rootOrConfig: string | HyperionConfig): ResolvedHyperionConfig {
    const inputConfig =
      typeof rootOrConfig === "string" ? { workspaceRoot: rootOrConfig } : rootOrConfig;
    const workspaceRoot = resolve(inputConfig.workspaceRoot);

    if (!existsSync(workspaceRoot)) {
      throw new HyperionPathError(`Workspace root does not exist: ${workspaceRoot}`);
    }

    const workspaceStat = statSync(workspaceRoot);
    if (!workspaceStat.isDirectory()) {
      throw new HyperionPathError(`Workspace root must be a directory: ${workspaceRoot}`);
    }

    const overrideDefaultIgnores = inputConfig.overrideDefaultIgnores ?? false;
    const ignoredPatterns = overrideDefaultIgnores
      ? [...(inputConfig.ignoredPatterns ?? [])]
      : [...DEFAULT_IGNORED_PATTERNS, ...(inputConfig.ignoredPatterns ?? [])];
    const defaultSessionRoot = join(workspaceRoot, ".hyperion", "checkpoints");
    const sessionRootInput = inputConfig.sessionRoot ?? defaultSessionRoot;
    const sessionRoot = isAbsolute(sessionRootInput)
      ? resolve(sessionRootInput)
      : resolve(workspaceRoot, sessionRootInput);

    if (!isPathInsideRoot(workspaceRoot, sessionRoot)) {
      throw new HyperionPathError(`Session root must be inside workspace root: ${sessionRoot}`);
    }

    return {
      workspaceRoot,
      useTmpfs: inputConfig.useTmpfs ?? true,
      ignoredPatterns,
      overrideDefaultIgnores,
      enableFsInterceptor: inputConfig.enableFsInterceptor ?? true,
      maxConcurrentCheckpoints:
        inputConfig.maxConcurrentCheckpoints ?? DEFAULT_MAX_CONCURRENT_CHECKPOINTS,
      sessionRoot,
      useHotBuffer: inputConfig.useHotBuffer ?? true,
      hotBufferMaxFileBytes:
        inputConfig.hotBufferMaxFileBytes ?? DEFAULT_HOT_BUFFER_MAX_FILE_BYTES,
      hotBufferMaxTotalBytes:
        inputConfig.hotBufferMaxTotalBytes ?? DEFAULT_HOT_BUFFER_MAX_TOTAL_BYTES,
      hotBufferMaxFiles: inputConfig.hotBufferMaxFiles ?? DEFAULT_HOT_BUFFER_MAX_FILES,
      strictIgnoredWrites: inputConfig.strictIgnoredWrites ?? false,
      durableAttemptJournals: inputConfig.durableAttemptJournals ?? true,
    };
  }

  private ensureSessionRoot(): string {
    return ensureSessionRoot(this.config.sessionRoot);
  }

  private probeSessionDeviceInfo(): SessionDeviceInfo {
    const deviceInfo = probeSessionDeviceInfo(this.root, this.ensureSessionRoot());
    this.sessionDeviceInfo = deviceInfo;
    return deviceInfo;
  }

  private refreshStrategySelection(deviceInfo: SessionDeviceInfo): void {
    this.environmentProfile = {
      ...this.environmentProfile,
      sameDeviceForLinks: deviceInfo.sameDevice,
    };
    this.strategySelection = selectStorageStrategy(this.config, this.environmentProfile);
  }

  private getCheckpoint(checkpointId: CheckpointId) {
    return this.checkpointStore.getCheckpoint(checkpointId);
  }

  private markCheckpointDisposed(checkpointId: CheckpointId): void {
    this.checkpointStore.markCheckpointDisposed(checkpointId);
    const checkpoint = this.checkpointStore.getCheckpoint(checkpointId);
    if (checkpoint) {
      this.writeAttemptJournalBestEffort(checkpoint);
    }
  }

  private backupCheckpointPath(checkpointId: CheckpointId, pathOrPathLike: string): void {
    this.requireKnownCheckpoint(checkpointId);
    const storage = this.requireCheckpointStorage(checkpointId);
    storage.backupFile(pathOrPathLike);
    this.writeBackupManifestBestEffort(checkpointId, storage);
  }

  private recordVfsMutations(records: VfsMutationRecord[]): void {
    const normalizedRecords = records
      .map((record) => ({
        record,
        relativePath: this.normalizeVfsPath(record.pathLike),
      }))
      .filter((entry): entry is { record: VfsMutationRecord; relativePath: string } =>
        entry.relativePath !== undefined,
      );

    for (const { record, relativePath } of normalizedRecords) {
      if (this.ignoreMatcher.matches(relativePath)) {
        this.recordIgnoredWrite(relativePath, record);
      }
    }

    const checkpoint = this.checkpointStore.getMostRecentActiveCheckpoint();

    if (!checkpoint) {
      return;
    }

    const storage = this.checkpointStorage.get(checkpoint.id);

    if (!storage) {
      return;
    }

    for (const { record, relativePath } of normalizedRecords) {
      if (this.ignoreMatcher.matches(relativePath)) {
        continue;
      }

      storage.backupFile(relativePath);
      checkpoint.dirty.set(
        relativePath,
        this.createVfsDirtyEntry(checkpoint, relativePath, record),
      );
    }

    this.writeBackupManifestBestEffort(checkpoint.id, storage);
    this.writeAttemptJournalBestEffort(checkpoint);
  }

  private recordIgnoredWrite(relativePath: string, record: VfsMutationRecord): void {
    const event: IgnoredWriteEvent = {
      relativePath,
      kind: record.kind,
      capturedAt: Date.now(),
    };

    this.ignoredWriteEvents.push(event);

    if (this.config.strictIgnoredWrites) {
      throw new HyperionIgnoredPathError(relativePath);
    }
  }

  private normalizeVfsPath(pathLike: unknown): string | undefined {
    try {
      if (typeof pathLike === "string") {
        return normalizeWorkspacePath(this.root, pathLike);
      }

      if (Buffer.isBuffer(pathLike)) {
        return normalizeWorkspacePath(this.root, pathLike.toString());
      }

      if (pathLike instanceof URL) {
        return normalizeWorkspacePath(this.root, fileURLToPath(pathLike));
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private createVfsDirtyEntry(
    checkpoint: StoredCheckpoint,
    relativePath: string,
    record: VfsMutationRecord,
  ): DirtyEntry {
    const now = Date.now();
    const existingEntry = checkpoint.dirty.get(relativePath);
    const baselineEntry = checkpoint.baseline.statEntries.get(relativePath);
    const dirtyEntry: DirtyEntry = {
      relativePath,
      kind: inferVfsDirtyKind(record, baselineEntry),
      fileType: baselineEntry?.type ?? record.fileTypeHint ?? "unknown",
      capturedBy: "vfs",
      firstSeenAt: existingEntry?.firstSeenAt ?? now,
      lastSeenAt: now,
    };

    if (baselineEntry) {
      dirtyEntry.before = baselineEntry;
    }

    if (existingEntry?.after) {
      dirtyEntry.after = existingEntry.after;
    }

    return dirtyEntry;
  }

  private get activeCheckpointCount(): number {
    return this.checkpointStore.activeCount;
  }

  private assertNotDisposed(operation: string): void {
    if (this.disposed) {
      throw new HyperionError(`Cannot call ${operation} after dispose()`);
    }
  }

  private requireKnownCheckpoint(checkpointId: CheckpointId) {
    const checkpoint = this.checkpointStore.getCheckpoint(checkpointId);

    if (!checkpoint) {
      throw new HyperionRollbackError(`Unknown checkpoint: ${checkpointId}`);
    }

    return checkpoint;
  }

  private requireActiveCheckpoint(checkpointId: CheckpointId) {
    const checkpoint = this.requireKnownCheckpoint(checkpointId);

    if (checkpoint.status === "disposed") {
      throw new HyperionRollbackError(`Checkpoint is already disposed: ${checkpointId}`);
    }

    if (checkpoint.status === "promoted") {
      throw new HyperionRollbackError(`Checkpoint is already promoted: ${checkpointId}`);
    }

    return checkpoint;
  }

  private requireCheckpointStorage(checkpointId: CheckpointId): StorageStrategy {
    const storage = this.checkpointStorage.get(checkpointId);

    if (!storage) {
      throw new HyperionRollbackError(`Missing storage for checkpoint: ${checkpointId}`);
    }

    return storage;
  }

  private cleanupCheckpointStorage(checkpointId: CheckpointId): void {
    const storage = this.checkpointStorage.get(checkpointId);

    if (!storage) {
      return;
    }

    storage.cleanup?.();
    this.checkpointStorage.delete(checkpointId);
  }

  private cleanupCheckpointStorageBestEffort(checkpointId: CheckpointId): void {
    const storage = this.checkpointStorage.get(checkpointId);

    if (!storage) {
      return;
    }

    try {
      storage.cleanup?.();
    } catch {
      // Capacity GC must continue freeing other disposed checkpoint namespaces.
    } finally {
      this.checkpointStorage.delete(checkpointId);
    }
  }

  private cleanupCheckpointStorageBestEffortWithResult(checkpointId: CheckpointId): boolean {
    const storage = this.checkpointStorage.get(checkpointId);

    if (!storage) {
      return true;
    }

    try {
      storage.cleanup?.();
      this.checkpointStorage.delete(checkpointId);
      return true;
    } catch {
      return false;
    }
  }

  private runCapacityGarbageCollection(): void {
    try {
      this.sessionManager.runStartupGarbageCollection();
    } catch {
      // Capacity GC is best-effort and must not mask capacity decisions.
    }

    for (const checkpoint of this.checkpointStore.getDisposedCheckpoints()) {
      this.cleanupCheckpointStorageBestEffort(checkpoint.id);
    }

    this.checkpointStore.collectDisposed();
  }

  private emergencyCleanupSync(): void {
    if (this.emergencyCleanupCompleted) {
      return;
    }

    this.emergencyCleanupCompleted = true;

    this.markActiveAttemptJournalsDisposed();

    try {
      this.vfsInterceptor.uninstall();
    } catch {
      // Emergency cleanup must never throw from process lifecycle handlers.
    }

    for (const checkpointId of [...this.checkpointStorage.keys()]) {
      const storage = this.checkpointStorage.get(checkpointId);

      try {
        storage?.cleanup?.();
      } catch {
        // Continue cleaning remaining checkpoint namespaces.
      } finally {
        this.checkpointStorage.delete(checkpointId);
      }
    }

    try {
      this.sessionManager.cleanupCurrentSession();
    } catch {
      // Current-session cleanup is best-effort.
    }
  }

  private writeAttemptJournal(checkpoint: StoredCheckpoint): void {
    if (!this.config.durableAttemptJournals) {
      return;
    }

    this.attemptJournalStore.write({
      checkpoint,
      strategy: this.strategySelection.kind,
      sessionId: this.storageSessionId,
      workspaceRoot: this.root,
    });
  }

  private writeAttemptJournalBestEffort(checkpoint: StoredCheckpoint): void {
    if (!this.config.durableAttemptJournals) {
      return;
    }

    this.attemptJournalStore.writeBestEffort({
      checkpoint,
      strategy: this.strategySelection.kind,
      sessionId: this.storageSessionId,
      workspaceRoot: this.root,
    });
  }

  private writeBackupManifestBestEffort(
    checkpointId: CheckpointId,
    storage: StorageStrategy,
  ): void {
    if (!this.config.durableAttemptJournals) {
      return;
    }

    this.attemptJournalStore.writeBackupsBestEffort(checkpointId, storage.getBackupRecords());
  }

  private assertRehydratable(
    journal: AttemptJournalEntry,
    backups: BackupManifestEntry | undefined,
  ): void {
    const requiredEntries = journal.dirty.filter((entry) =>
      entry.kind === "modified" || entry.kind === "deleted" || entry.kind === "metadata",
    );

    if (requiredEntries.length === 0) {
      return;
    }

    if (!backups) {
      throw new HyperionIntegrityError(`Missing backup manifest for ${journal.checkpointId}`);
    }

    const recordsByPath = new Map(backups.records.map((record) => [record.relativePath, record]));

    for (const entry of requiredEntries) {
      const record = recordsByPath.get(entry.relativePath);

      if (!record) {
        throw new HyperionIntegrityError(`Missing backup record for ${entry.relativePath}`);
      }

      if (record.volatile) {
        throw new HyperionIntegrityError(`Backup record is volatile for ${entry.relativePath}`);
      }

      if (record.kind === "file" && (!record.backupPath || !existsSync(record.backupPath))) {
        throw new HyperionIntegrityError(`Missing backup file for ${entry.relativePath}`);
      }
    }
  }

  private markActiveAttemptJournalsDisposed(): void {
    for (const checkpointId of [...this.checkpointStorage.keys()]) {
      const checkpoint = this.checkpointStore.getCheckpoint(checkpointId);

      if (
        !checkpoint ||
        checkpoint.status === "disposed" ||
        checkpoint.status === "promoted"
      ) {
        continue;
      }

      checkpoint.status = "disposed";
      this.writeAttemptJournalBestEffort(checkpoint);
    }
  }
}

function stateManifestFromJournal(journal: AttemptJournalEntry): StateManifest {
  const manifest: StateManifest = {
    gitAvailable: journal.baseline.gitAvailable,
    gitIndexEntries: new Map(
      journal.baseline.gitIndexEntries.map((entry) => [entry.relativePath, entry]),
    ),
    statEntries: new Map(
      journal.baseline.statEntries.map((entry) => [entry.relativePath, entry]),
    ),
    ignoredPatterns: [...journal.ignoredPatterns],
    capturedAt: journal.baseline.capturedAt,
  };

  if (journal.gitHead) {
    manifest.gitHead = journal.gitHead;
  }

  return manifest;
}

function dirtyMapFromJournal(journal: AttemptJournalEntry): Map<string, DirtyEntry> {
  return new Map(
    journal.dirty.map((entry) => [
      entry.relativePath,
      {
        relativePath: entry.relativePath,
        kind: entry.kind,
        fileType: entry.fileType,
        capturedBy: entry.capturedBy,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
      },
    ]),
  );
}

function inferVfsDirtyKind(
  record: VfsMutationRecord,
  baselineEntry: StatLedgerEntry | undefined,
): DirtyEntry["kind"] {
  if (!baselineEntry) {
    return "created";
  }

  if (record.kind === "delete") {
    return "deleted";
  }

  if (record.kind === "metadata" || record.kind === "mkdir") {
    return "metadata";
  }

  return "modified";
}
