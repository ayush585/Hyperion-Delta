import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_IGNORED_PATTERNS, DEFAULT_MAX_CONCURRENT_CHECKPOINTS } from "./constants.js";
import { HyperionError, HyperionPathError, HyperionRollbackError } from "./errors.js";
import type { CheckpointId, HyperionConfig, ReconcileResult, ResolvedHyperionConfig } from "./types.js";

export class HyperionWorkspace {
  public readonly root: string;
  public readonly config: ResolvedHyperionConfig;
  public readonly strategy = "pure-manifest" as const;

  private fsInterceptorInstalled = false;
  private disposed = false;

  public constructor(rootOrConfig: string | HyperionConfig) {
    const config = this.resolveConfig(rootOrConfig);
    this.root = config.workspaceRoot;
    this.config = config;
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
    }
  }

  public async snapshot(): Promise<CheckpointId> {
    throw new HyperionError("snapshot() is not implemented yet");
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

    return {
      workspaceRoot,
      useTmpfs: inputConfig.useTmpfs ?? true,
      ignoredPatterns,
      overrideDefaultIgnores,
      enableFsInterceptor: inputConfig.enableFsInterceptor ?? true,
      maxConcurrentCheckpoints:
        inputConfig.maxConcurrentCheckpoints ?? DEFAULT_MAX_CONCURRENT_CHECKPOINTS,
      sessionRoot: resolve(inputConfig.sessionRoot ?? `${workspaceRoot}/.hyperion/checkpoints`),
    };
  }
}
