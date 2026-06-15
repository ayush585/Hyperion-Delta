import { HyperionWorkspace } from "./workspace.js";
import type {
  CheckpointId,
  HyperionConfig,
  ReconcileResult,
  StorageStrategyKind,
} from "./types.js";

export interface HyperionAgentSessionDiagnostics {
  strategy: StorageStrategyKind;
  lastReconcileResult?: ReconcileResult;
  lastRollbackMs?: number;
  isDisposed: boolean;
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
    const diagnostics: HyperionAgentSessionDiagnostics = {
      strategy: this.strategy,
      isDisposed: this.isDisposed,
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

  public dispose(): Promise<void> {
    return this.workspace.dispose();
  }
}
