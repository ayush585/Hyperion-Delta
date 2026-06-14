import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { DEFAULT_IGNORED_PATTERNS, DEFAULT_MAX_CONCURRENT_CHECKPOINTS } from "./constants.js";
import { HyperionError, HyperionPathError, HyperionRollbackError } from "./errors.js";
import { CheckpointStore } from "./internal/checkpoint-store.js";
import {
  discoverEnvironmentProfile,
  type EnvironmentProfile,
} from "./internal/environment.js";
import { createIgnoreMatcher, type IgnoreMatcher } from "./internal/ignore.js";
import { isPathInsideRoot, normalizeWorkspacePath } from "./internal/path.js";
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
import type {
  CheckpointId,
  HyperionConfig,
  ReconcileResult,
  ResolvedHyperionConfig,
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
  private readonly manualTrackedPaths = new Set<string>();
  private sessionDeviceInfo?: SessionDeviceInfo;
  private fsInterceptorInstalled = false;
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

    return checkpoint.id;
  }

  public async rollback(_checkpointId: CheckpointId): Promise<void> {
    throw new HyperionRollbackError("rollback() is not implemented yet");
  }

  public async reconcile(checkpointId?: CheckpointId): Promise<ReconcileResult> {
    if (checkpointId) {
      throw new HyperionError("reconcile() is not implemented yet");
    }

    return {
      created: [],
      modified: [],
      deleted: [],
      renamed: [],
    };
  }

  public async dispose(): Promise<void> {
    this.checkpointStore.clear();
    this.disposed = true;
    this.fsInterceptorInstalled = false;
  }

  public installFsInterceptor(): void {
    if (this.disposed) {
      throw new HyperionError("Cannot install fs interceptor after dispose()");
    }

    this.fsInterceptorInstalled = true;
  }

  public uninstallFsInterceptor(): void {
    this.fsInterceptorInstalled = false;
  }

  public get isFsInterceptorInstalled(): boolean {
    return this.fsInterceptorInstalled;
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

  private get activeCheckpointCount(): number {
    return this.checkpointStore.activeCount;
  }

  private assertNotDisposed(operation: string): void {
    if (this.disposed) {
      throw new HyperionError(`Cannot call ${operation} after dispose()`);
    }
  }
}
