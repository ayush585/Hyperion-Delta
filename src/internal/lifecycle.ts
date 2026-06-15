export const LIFECYCLE_EVENTS = [
  "exit",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "uncaughtException",
  "unhandledRejection",
] as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];
export type LifecycleSignal = Extract<LifecycleEvent, NodeJS.Signals>;
export type LifecycleHandler = (...args: unknown[]) => void;
export type LifecycleCleanupCallback = () => void;

export interface LifecycleProcessAdapter {
  readonly pid: number;
  once(event: LifecycleEvent, handler: LifecycleHandler): void;
  off(event: LifecycleEvent, handler: LifecycleHandler): void;
  kill(pid: number, signal: LifecycleSignal): void;
  rethrow(reason: unknown): never;
}

const nodeLifecycleProcessAdapter: LifecycleProcessAdapter = {
  pid: process.pid,
  once(event, handler): void {
    process.once(event, handler as (...args: any[]) => void);
  },
  off(event, handler): void {
    process.off(event, handler as (...args: any[]) => void);
  },
  kill(pid, signal): void {
    process.kill(pid, signal);
  },
  rethrow(reason): never {
    if (reason instanceof Error) {
      throw reason;
    }

    throw new Error(String(reason));
  },
};

let defaultLifecycleProcessAdapter = nodeLifecycleProcessAdapter;

export function setDefaultLifecycleProcessAdapterForTests(
  adapter: LifecycleProcessAdapter | undefined,
): void {
  defaultLifecycleProcessAdapter = adapter ?? nodeLifecycleProcessAdapter;
}

export class LifecycleCleanupRegistry {
  private readonly cleanupCallbacks = new Set<LifecycleCleanupCallback>();
  private readonly handlers = new Map<LifecycleEvent, LifecycleHandler>();
  private registered = false;
  private cleanupHasRun = false;

  public constructor(
    private readonly processAdapter: LifecycleProcessAdapter = defaultLifecycleProcessAdapter,
  ) {}

  public addCleanupCallback(callback: LifecycleCleanupCallback): void {
    this.cleanupCallbacks.add(callback);
  }

  public register(): void {
    if (this.registered) {
      return;
    }

    for (const event of LIFECYCLE_EVENTS) {
      const handler = (...args: unknown[]) => {
        this.handleLifecycleEvent(event, args);
      };
      this.handlers.set(event, handler);
      this.processAdapter.once(event, handler);
    }

    this.registered = true;
  }

  public unregister(): void {
    if (!this.registered) {
      return;
    }

    for (const [event, handler] of this.handlers) {
      this.processAdapter.off(event, handler);
    }

    this.handlers.clear();
    this.registered = false;
  }

  public runEmergencyCleanup(): void {
    if (this.cleanupHasRun) {
      return;
    }

    this.cleanupHasRun = true;

    for (const callback of this.cleanupCallbacks) {
      try {
        callback();
      } catch {
        // Emergency cleanup is best-effort; one failure must not block the rest.
      }
    }
  }

  public get isRegistered(): boolean {
    return this.registered;
  }

  private handleLifecycleEvent(event: LifecycleEvent, args: unknown[]): void {
    this.runEmergencyCleanup();

    if (event === "exit") {
      return;
    }

    this.unregister();

    if (isLifecycleSignal(event)) {
      this.processAdapter.kill(this.processAdapter.pid, event);
      return;
    }

    this.processAdapter.rethrow(args[0]);
  }
}

function isLifecycleSignal(event: LifecycleEvent): event is LifecycleSignal {
  return event === "SIGINT" || event === "SIGTERM" || event === "SIGHUP";
}
