import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

import { HyperionWorkspace } from "./workspace.js";
import type {
  CheckpointId,
  HyperionConfig,
  HyperionDiagnostics,
  HyperionPromoteOptions,
  HyperionPromotionResult,
  HyperionToolOutputContract,
  RecoverableAttempt,
  ReconcileResult,
  StorageStrategyKind,
} from "./types.js";

export interface HyperionExecResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

export interface HyperionExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  rejectOnNonZero?: boolean;
  captureOutput?: boolean;
  timeoutMs?: number;
}

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

export interface HyperionAttemptContext {
  checkpointId: CheckpointId;
  workspace: HyperionWorkspace;
  reconcile(): Promise<ReconcileResult>;
  exec(command: string, args?: string[], options?: HyperionExecOptions): Promise<HyperionExecResult>;
}

export interface HyperionAttemptOptions {
  rollbackOnThrow?: boolean;
  reconcileOnSuccess?: boolean;
}

export interface HyperionAttemptResult<T> {
  checkpointId: CheckpointId;
  result: T;
  reconcileResult?: ReconcileResult;
  rolledBack: boolean;
  rollbackMs?: number;
}

export interface HyperionAgentSessionDiagnostics extends HyperionDiagnostics {
  lastReconcileResult?: ReconcileResult;
  lastRollbackMs?: number;
}

export class HyperionExecError extends Error {
  public readonly result: HyperionExecResult;

  public constructor(result: HyperionExecResult) {
    super(`Command failed with exit code ${result.exitCode}: ${result.command}`);
    this.name = "HyperionExecError";
    this.result = result;
  }
}

export class HyperionAttemptRollbackError extends Error {
  public readonly checkpointId: CheckpointId;
  public readonly attemptError: unknown;
  public readonly rollbackError: unknown;
  public readonly reconcileResult?: ReconcileResult;

  public constructor(input: {
    checkpointId: CheckpointId;
    attemptError: unknown;
    rollbackError: unknown;
    reconcileResult?: ReconcileResult;
  }) {
    super("Hyperion runAttempt() failed and rollback also failed");
    this.name = "HyperionAttemptRollbackError";
    this.checkpointId = input.checkpointId;
    this.attemptError = input.attemptError;
    this.rollbackError = input.rollbackError;
    if (input.reconcileResult) {
      this.reconcileResult = input.reconcileResult;
    }
  }
}

export class HyperionAgentSession {
  public readonly workspace: HyperionWorkspace;

  private lastReconcileResultValue?: ReconcileResult;
  private lastRollbackMsValue?: number;

  public constructor(rootOrConfig: string | HyperionConfig) {
    this.workspace = new HyperionWorkspace(rootOrConfig);

    if (this.workspace.config.enableFsInterceptor) {
      this.workspace.installFsInterceptor();
    }
  }

  public get strategy(): StorageStrategyKind {
    return this.workspace.strategy;
  }

  public get lastReconcileResult(): ReconcileResult | undefined {
    return this.lastReconcileResultValue;
  }

  public get lastRollbackMs(): number | undefined {
    return this.lastRollbackMsValue;
  }

  public get isDisposed(): boolean {
    return this.workspace.isDisposed;
  }

  public get diagnostics(): HyperionAgentSessionDiagnostics {
    return this.getDiagnostics();
  }

  public getDiagnostics(): HyperionAgentSessionDiagnostics {
    const diagnostics: HyperionAgentSessionDiagnostics = {
      ...this.workspace.getDiagnostics(),
    };

    if (this.lastReconcileResultValue) {
      diagnostics.lastReconcileResult = this.lastReconcileResultValue;
    }

    if (this.lastRollbackMsValue !== undefined) {
      diagnostics.lastRollbackMs = this.lastRollbackMsValue;
    }

    return diagnostics;
  }

  public snapshot(): Promise<CheckpointId> {
    return this.workspace.snapshot();
  }

  public declareToolOutputs(contract: HyperionToolOutputContract): void {
    this.workspace.declareToolOutputs(contract);
  }

  public async reconcile(checkpointId?: CheckpointId): Promise<ReconcileResult> {
    const result = await this.workspace.reconcile(checkpointId);
    this.lastReconcileResultValue = result;
    return result;
  }

  public async rollback(checkpointId: CheckpointId): Promise<void> {
    const startedAt = process.hrtime.bigint();

    try {
      await this.workspace.rollback(checkpointId);
    } finally {
      this.lastRollbackMsValue = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    }
  }

  public async runAttempt<T>(
    callback: (context: HyperionAttemptContext) => T | Promise<T>,
    options: HyperionAttemptOptions = {},
  ): Promise<HyperionAttemptResult<T>> {
    const checkpointId = await this.snapshot();
    const context: HyperionAttemptContext = {
      checkpointId,
      workspace: this.workspace,
      reconcile: () => this.reconcile(checkpointId),
      exec: (command, args = [], execOptions = {}) =>
        this.execute(command, args, execOptions, checkpointId),
    };

    try {
      const result = await callback(context);
      const reconcileResult = options.reconcileOnSuccess === false
        ? undefined
        : await this.reconcile(checkpointId);
      const attemptResult: HyperionAttemptResult<T> = {
        checkpointId,
        result,
        rolledBack: false,
      };

      if (reconcileResult) {
        attemptResult.reconcileResult = reconcileResult;
      }

      return attemptResult;
    } catch (attemptError) {
      let reconcileResult: ReconcileResult | undefined;

      try {
        reconcileResult = await this.reconcile(checkpointId);
      } catch {
        // rollback() performs mandatory reconciliation again; preserve the attempt error.
      }

      if (options.rollbackOnThrow === false) {
        throw annotateAttemptError(attemptError, buildAttemptErrorContext({
          checkpointId,
          reconcileResult,
          rolledBack: false,
        }));
      }

      try {
        await this.rollback(checkpointId);
      } catch (rollbackError) {
        const rollbackFailureInput: ConstructorParameters<typeof HyperionAttemptRollbackError>[0] = {
          checkpointId,
          attemptError,
          rollbackError,
        };

        if (reconcileResult) {
          rollbackFailureInput.reconcileResult = reconcileResult;
        }

        throw new HyperionAttemptRollbackError(rollbackFailureInput);
      }

      throw annotateAttemptError(attemptError, buildAttemptErrorContext({
        checkpointId,
        reconcileResult,
        rolledBack: true,
        rollbackMs: this.lastRollbackMs,
      }));
    }
  }

  public exec(
    command: string,
    args: string[] = [],
    options: HyperionExecOptions = {},
  ): Promise<HyperionExecResult> {
    return this.execute(command, args, options);
  }

  public recoverAttempts(): Promise<RecoverableAttempt[]> {
    return this.workspace.recoverAttempts();
  }

  public exportPatch(checkpointId: CheckpointId): Promise<string> {
    return this.workspace.exportPatch(checkpointId);
  }

  public promote(
    checkpointId: CheckpointId,
    options?: HyperionPromoteOptions,
  ): Promise<HyperionPromotionResult> {
    return this.workspace.promote(checkpointId, options);
  }

  public rehydrateAttempt(checkpointId: CheckpointId): Promise<CheckpointId> {
    return this.workspace.rehydrateAttempt(checkpointId);
  }

  public dispose(): Promise<void> {
    return this.workspace.dispose();
  }

  private execute(
    command: string,
    args: string[],
    options: HyperionExecOptions,
    checkpointId?: CheckpointId,
  ): Promise<HyperionExecResult> {
    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timeoutMs = resolveExecTimeoutMs(options.timeoutMs);
      const child = spawn(command, args, {
        cwd: options.cwd ?? this.workspace.root,
        env: options.env,
        shell: false,
        stdio: options.captureOutput ? ["ignore", "pipe", "pipe"] : (options.stdio ?? "inherit"),
      });
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const clearTimeouts = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      };

      const settle = (handler: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeouts();
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        handler();
      };

      if (options.captureOutput) {
        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk);
        });
      }

      const onError = (error: unknown) => {
        settle(() => reject(error));
      };

      const onClose = async (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }

        clearTimeouts();

        const result: HyperionExecResult = {
          command,
          args: [...args],
          exitCode,
          signal,
        };

        if (options.captureOutput) {
          result.stdout = Buffer.concat(stdoutChunks).toString("utf8");
          result.stderr = Buffer.concat(stderrChunks).toString("utf8");
        }

        try {
          if (checkpointId) {
            await this.reconcile(checkpointId);
          }

          if ((options.rejectOnNonZero ?? true) && exitCode !== 0) {
            settle(() => reject(new HyperionExecError(result)));
            return;
          }

          settle(() => resolve(result));
        } catch (error) {
          settle(() => reject(error));
        }
      };

      child.once("error", onError);
      child.once("close", onClose);

      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          if (settled) {
            return;
          }

          terminateChildProcess(child);

          settle(() => reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`)));
        }, timeoutMs);
        timeoutHandle.unref?.();
      }
    });
  }
}

function resolveExecTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`timeoutMs must be a non-negative finite number: ${timeoutMs}`);
  }

  if (timeoutMs === 0) {
    return undefined;
  }

  return Math.floor(timeoutMs);
}

function terminateChildProcess(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    if (signal) {
      child.kill(signal);
    } else {
      child.kill();
    }
  } catch {}
}

function annotateAttemptError(
  error: unknown,
  context: {
    checkpointId: CheckpointId;
    reconcileResult?: ReconcileResult;
    rolledBack: boolean;
    rollbackMs?: number;
  },
): unknown {
  if (typeof error === "object" && error !== null) {
    Object.assign(error, context);
    return error;
  }

  return Object.assign(new Error(String(error)), context);
}

function buildAttemptErrorContext(input: {
  checkpointId: CheckpointId;
  reconcileResult?: ReconcileResult | undefined;
  rolledBack: boolean;
  rollbackMs?: number | undefined;
}): {
  checkpointId: CheckpointId;
  reconcileResult?: ReconcileResult;
  rolledBack: boolean;
  rollbackMs?: number;
} {
  const context: {
    checkpointId: CheckpointId;
    reconcileResult?: ReconcileResult;
    rolledBack: boolean;
    rollbackMs?: number;
  } = {
    checkpointId: input.checkpointId,
    rolledBack: input.rolledBack,
  };

  if (input.reconcileResult) {
    context.reconcileResult = input.reconcileResult;
  }

  if (input.rollbackMs !== undefined) {
    context.rollbackMs = input.rollbackMs;
  }

  return context;
}
