import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_IGNORED_PATTERNS, DEFAULT_MAX_CONCURRENT_CHECKPOINTS } from "./constants.js";
import { HyperionError, HyperionPathError, HyperionRollbackError } from "./errors.js";
import { CheckpointStore, type StoredCheckpoint } from "./internal/checkpoint-store.js";
import {
  discoverEnvironmentProfile,
  type EnvironmentProfile,
} from "./internal/environment.js";
import { GhostDirectoryCleaner } from "./internal/ghost-directory-cleaner.js";
import { createIgnoreMatcher, type IgnoreMatcher } from "./internal/ignore.js";
import { isPathInsideRoot, normalizeWorkspacePath } from "./internal/path.js";
import { ReconciliationEngine } from "./internal/reconciliation-engine.js";
import { RollbackEngine } from "./internal/rollback-engine.js";
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
  ReconcileResult,
  ResolvedHyperionConfig,
  StatLedgerEntry,
  StorageStrategyKind,
} from "./types.js";

export class HyperionWorkspace {
  public readonly root: string;
  public readonly config: ResolvedHyperionConfig;
  public readonly strategy: StorageStrategyKind;

  private readonly ignoreMatcher: IgnoreMatcher;
  private readonly environmentProfile: EnvironmentProfile;
  private readonly strategySelection: StrategySelection;
  private readonly stateEngine: HybridStateEngine;
  private readonly checkpointStore: CheckpointStore;
  private readonly checkpointStorage = new Map<CheckpointId, StorageStrategy>();
  private readonly storageSessionId = randomUUID();
  private readonly rollbackEngine = new RollbackEngine();
  private readonly reconciliationEngine = new ReconciliationEngine();
  private readonly vfsInterceptor: VfsInterceptor;
  private readonly manualTrackedPaths = new Set<string>();
  private sessionDeviceInfo?: SessionDeviceInfo;
  private disposed = false;

  public constructor(rootOrConfig: string | HyperionConfig) {
    const config = this.resolveConfig(rootOrConfig);
    this.root = config.workspaceRoot;
    this.config = config;
    this.ignoreMatcher = createIgnoreMatcher(config.ignoredPatterns);
    this.environmentProfile = discoverEnvironmentProfile({
      workspaceRoot: config.workspaceRoot,
      sessionRoot: config.sessionRoot,
    });
    this.strategySelection = selectStorageStrategy(config, this.environmentProfile);
    this.strategy = this.strategySelection.kind;
    this.stateEngine = new HybridStateEngine(config, {
      gitAvailableHint: this.environmentProfile.gitAvailable,
    });
    this.checkpointStore = new CheckpointStore(config);
    this.vfsInterceptor = new VfsInterceptor({
      beforeMutation: (records) => {
        this.recordVfsMutations(records);
      },
    });
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
      if (!this.ignoreMatcher.matches(relativePath)) {
        this.manualTrackedPaths.add(relativePath);
      }
    }
  }

  public async snapshot(): Promise<CheckpointId> {
    this.assertNotDisposed("snapshot()");
    this.checkpointStore.collectDisposed();
    this.checkpointStore.ensureCapacityAvailable();
    this.ensureSessionRoot();

    const baseline = this.stateEngine.captureManifest();
    const deviceInfo = this.probeSessionDeviceInfo();
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
      }),
    );

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

    await this.rollbackEngine.rollback({
      checkpoint,
      storage,
      ghostDirectoryCleaner,
      reconcile: async () => {
        await this.reconcile(checkpointId);
      },
    });
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
    return this.reconciliationEngine.reconcile({ checkpoint, currentManifest });
  }

  public async dispose(): Promise<void> {
    this.uninstallFsInterceptor();
    for (const checkpointId of [...this.checkpointStorage.keys()]) {
      this.cleanupCheckpointStorage(checkpointId);
    }
    this.checkpointStore.clear();
    this.disposed = true;
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

  private getCheckpoint(checkpointId: CheckpointId) {
    return this.checkpointStore.getCheckpoint(checkpointId);
  }

  private markCheckpointDisposed(checkpointId: CheckpointId): void {
    this.checkpointStore.markCheckpointDisposed(checkpointId);
  }

  private backupCheckpointPath(checkpointId: CheckpointId, pathOrPathLike: string): void {
    this.requireKnownCheckpoint(checkpointId);
    this.requireCheckpointStorage(checkpointId).backupFile(pathOrPathLike);
  }

  private recordVfsMutations(records: VfsMutationRecord[]): void {
    const checkpoint = this.checkpointStore.getMostRecentActiveCheckpoint();

    if (!checkpoint) {
      return;
    }

    const storage = this.checkpointStorage.get(checkpoint.id);

    if (!storage) {
      return;
    }

    for (const record of records) {
      const relativePath = this.normalizeVfsPath(record.pathLike);

      if (!relativePath || this.ignoreMatcher.matches(relativePath)) {
        continue;
      }

      storage.backupFile(relativePath);
      checkpoint.dirty.set(
        relativePath,
        this.createVfsDirtyEntry(checkpoint, relativePath, record),
      );
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
