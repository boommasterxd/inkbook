import { describe, expect, it } from "vitest";

import { createWindowWorkScheduler } from "../../../../src/obsidian/performance/window-work-scheduler";

function createHost(withChannel = true, postFails = false) {
  let time = 0;
  let nextHandle = 0;
  let openPorts = 0;
  let channels = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const messages: Array<() => void> = [];
  const timeoutDelays: number[] = [];
  class TestChannel {
    public readonly port1 = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      close: () => {
        this.port1.onmessage = null;
        openPorts -= 1;
      },
    };
    public readonly port2 = {
      postMessage: () => {
        if (postFails) throw new Error("Channel unavailable.");
        messages.push(() => this.port1.onmessage?.({} as MessageEvent));
      },
      close: () => {
        openPorts -= 1;
      },
    };
    public constructor() {
      channels += 1;
      openPorts += 2;
    }
  }
  const ownerWindow = {
    performance: { now: () => time },
    document: { visibilityState: "visible" },
    MessageChannel: withChannel ? TestChannel : undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const handle = ++nextHandle;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle: number) => frames.delete(handle),
    setTimeout: (callback: () => void, delay: number) => {
      const handle = ++nextHandle;
      timers.set(handle, { callback, delay });
      timeoutDelays.push(delay);
      return handle;
    },
    clearTimeout: (handle: number) => timers.delete(handle),
  } as unknown as Window;
  return {
    ownerWindow,
    setTime(value: number) {
      time = value;
    },
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
    },
    message() {
      const pending = messages.shift();
      if (pending === undefined) throw new Error("No message is pending.");
      pending();
    },
    timer(delay: number) {
      const pending = [...timers].find(([, entry]) => entry.delay === delay);
      if (pending === undefined) throw new Error(`No ${delay} ms timer is pending.`);
      timers.delete(pending[0]);
      pending[1].callback();
    },
    get openPorts() {
      return openPorts;
    },
    get channels() {
      return channels;
    },
    get pendingFrames() {
      return frames.size;
    },
    get pendingTimers() {
      return timers.size;
    },
    get pendingMessages() {
      return messages.length;
    },
    timeoutDelays,
  };
}

describe("window work scheduler task dispatch", () => {
  it("reuses one channel for idle boundaries and nested work continuations", async () => {
    const host = createHost();
    const scheduler = createWindowWorkScheduler(host.ownerWindow, () => ({
      sliceBudgetMs: 4,
      frameDurationMs: 8,
    }));
    expect(scheduler.deadline()).toBe(4);
    host.setTime(4);
    const resumed: number[] = [];
    const first = (async () => {
      await scheduler.checkpoint();
      await Promise.resolve();
      await Promise.resolve();
      host.setTime(12);
      resumed.push(1);
    })();
    const second = scheduler.checkpoint()?.then(() => resumed.push(2));
    host.setTime(8);
    host.frame();
    await first;
    expect(resumed).toEqual([1]);
    host.message();
    host.message();
    expect(resumed).toEqual([1]);
    expect(host.pendingFrames).toBe(1);
    expect(host.channels).toBe(1);
    expect(host.openPorts).toBe(2);
    expect(host.timeoutDelays).toEqual([50, 50]);
    host.setTime(16);
    host.frame();
    await second;
    scheduler.dispose();
    expect(host.openPorts).toBe(0);
    expect(host.pendingFrames).toBe(0);
    expect(host.pendingTimers).toBe(0);
  });

  it("falls back to cancellable zero-delay timers when MessageChannel is absent", () => {
    const host = createHost(false);
    const scheduler = createWindowWorkScheduler(host.ownerWindow, () => ({
      sliceBudgetMs: 4,
      frameDurationMs: 8,
    }));
    scheduler.deadline();
    expect(host.timeoutDelays).toEqual([0]);
    host.timer(0);
    host.setTime(8);
    expect(scheduler.shouldYield()).toBe(false);
    scheduler.dispose();
    expect(host.pendingTimers).toBe(0);
    expect(host.channels).toBe(0);
  });

  it("closes its channel and cancels pending native work on disposal", async () => {
    const host = createHost();
    const scheduler = createWindowWorkScheduler(host.ownerWindow, () => ({
      sliceBudgetMs: 4,
      frameDurationMs: 8,
    }));
    scheduler.deadline();
    host.setTime(4);
    const wait = scheduler.checkpoint();
    expect(wait).toBeDefined();
    expect(host.pendingFrames).toBe(1);
    expect(host.pendingMessages).toBe(1);
    scheduler.dispose();
    await expect(wait).rejects.toThrow("disposed");
    expect(host.openPorts).toBe(0);
    expect(host.pendingFrames).toBe(0);
    expect(host.pendingTimers).toBe(0);
    host.message();
    expect(host.pendingMessages).toBe(0);
  });

  it("closes a failed channel and transfers its pending task to a timer", () => {
    const host = createHost(true, true);
    const scheduler = createWindowWorkScheduler(host.ownerWindow, () => ({
      sliceBudgetMs: 4,
      frameDurationMs: 8,
    }));
    scheduler.deadline();
    expect(host.channels).toBe(1);
    expect(host.openPorts).toBe(0);
    expect(host.timeoutDelays).toEqual([0]);
    host.timer(0);
    scheduler.dispose();
    expect(host.pendingTimers).toBe(0);
  });
});
