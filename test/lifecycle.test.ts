import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LIFECYCLE_EVENTS,
  LifecycleCleanupRegistry,
  type LifecycleEvent,
  type LifecycleHandler,
  type LifecycleProcessAdapter,
  type LifecycleSignal,
} from "../src/internal/lifecycle.js";

class FakeLifecycleProcessAdapter implements LifecycleProcessAdapter {
  public readonly pid = 12345;
  public readonly handlers = new Map<LifecycleEvent, Set<LifecycleHandler>>();
  public readonly killedSignals: LifecycleSignal[] = [];
  public readonly rethrownReasons: unknown[] = [];

  public once(event: LifecycleEvent, handler: LifecycleHandler): void {
    const handlers = this.handlers.get(event) ?? new Set<LifecycleHandler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  public off(event: LifecycleEvent, handler: LifecycleHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  public kill(_pid: number, signal: LifecycleSignal): void {
    this.killedSignals.push(signal);
  }

  public rethrow(reason: unknown): never {
    this.rethrownReasons.push(reason);

    if (reason instanceof Error) {
      throw reason;
    }

    throw new Error(String(reason));
  }

  public listenerCount(event: LifecycleEvent): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  public emit(event: LifecycleEvent, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(...args);
    }
  }
}

describe("LifecycleCleanupRegistry", () => {
  it("registers all lifecycle events exactly once", () => {
    const adapter = new FakeLifecycleProcessAdapter();
    const registry = new LifecycleCleanupRegistry(adapter);

    registry.register();
    registry.register();

    for (const event of LIFECYCLE_EVENTS) {
      assert.equal(adapter.listenerCount(event), 1);
    }
  });

  it("unregisters all lifecycle handlers", () => {
    const adapter = new FakeLifecycleProcessAdapter();
    const registry = new LifecycleCleanupRegistry(adapter);

    registry.register();
    registry.unregister();
    registry.unregister();

    for (const event of LIFECYCLE_EVENTS) {
      assert.equal(adapter.listenerCount(event), 0);
    }
  });

  it("runs cleanup only once even if lifecycle handlers are triggered repeatedly", () => {
    const adapter = new FakeLifecycleProcessAdapter();
    const registry = new LifecycleCleanupRegistry(adapter);
    let cleanupCount = 0;
    registry.addCleanupCallback(() => {
      cleanupCount += 1;
    });

    registry.register();
    adapter.emit("exit", 0);
    adapter.emit("exit", 0);
    registry.runEmergencyCleanup();

    assert.equal(cleanupCount, 1);
  });

  it("swallows cleanup errors and continues running later callbacks", () => {
    const adapter = new FakeLifecycleProcessAdapter();
    const registry = new LifecycleCleanupRegistry(adapter);
    let laterCleanupCalled = false;
    registry.addCleanupCallback(() => {
      throw new Error("cleanup failed");
    });
    registry.addCleanupCallback(() => {
      laterCleanupCalled = true;
    });

    assert.doesNotThrow(() => {
      registry.runEmergencyCleanup();
    });
    assert.equal(laterCleanupCalled, true);
  });

  it("cleans, unregisters, and re-emits signals through the adapter", () => {
    const adapter = new FakeLifecycleProcessAdapter();
    const registry = new LifecycleCleanupRegistry(adapter);
    let cleanupCalled = false;
    registry.addCleanupCallback(() => {
      cleanupCalled = true;
    });

    registry.register();
    adapter.emit("SIGTERM");

    assert.equal(cleanupCalled, true);
    assert.deepEqual(adapter.killedSignals, ["SIGTERM"]);
    for (const event of LIFECYCLE_EVENTS) {
      assert.equal(adapter.listenerCount(event), 0);
    }
  });

  it("cleans, unregisters, and rethrows crash reasons through the adapter", () => {
    const adapter = new FakeLifecycleProcessAdapter();
    const registry = new LifecycleCleanupRegistry(adapter);
    const crash = new Error("boom");
    let cleanupCalled = false;
    registry.addCleanupCallback(() => {
      cleanupCalled = true;
    });

    registry.register();

    assert.throws(() => {
      adapter.emit("uncaughtException", crash);
    }, crash);
    assert.equal(cleanupCalled, true);
    assert.deepEqual(adapter.rethrownReasons, [crash]);
    for (const event of LIFECYCLE_EVENTS) {
      assert.equal(adapter.listenerCount(event), 0);
    }
  });
});
