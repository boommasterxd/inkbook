import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerWorkScheduler } from "../../../../../src/persistence/worker/runtime/worker-work-scheduler";
import { createProductionDocumentRuntime } from "../../../../../src/persistence/worker/runtime/production-document-runtime";
import { ManualWorkerTiming } from "../../../../fixtures/persistence/manual-worker-timing";

afterEach(() => vi.unstubAllGlobals());

describe("worker work scheduler", () => {
  it.each([60, 90, 120, 144, 240])(
    "resumes an exhausted %i Hz slice on a task without waiting for a frame",
    async (rate) => {
      const timing = new ManualWorkerTiming();
      const sliceMilliseconds = (1_000 / rate) * 0.55;
      const { workScheduler } = createWorkerWorkScheduler(
        { frameIntervalMilliseconds: 1_000 / rate, sliceMilliseconds },
        timing,
      );
      expect(workScheduler.deadline()).toBeCloseTo(sliceMilliseconds);
      timing.time = sliceMilliseconds;
      let resumed = false;
      const wait = workScheduler.checkpoint()?.then(() => {
        resumed = true;
      });
      expect(wait).toBeDefined();

      for (let task = 0; task < 3 && !resumed; task += 1) {
        timing.runNextTask();
        await Promise.resolve();
      }
      expect(resumed).toBe(true);
      expect(timing.delays).toEqual([]);
      expect(timing.channelAttempts).toBe(1);
      expect(workScheduler.deadline()).toBeCloseTo(sliceMilliseconds * 2);
      await wait;
      expect(timing.pendingMessages).toBe(1);
      timing.runNextTask();
      expect(timing.pendingTimers).toBe(0);
      workScheduler.dispose();
      expect(timing.pendingTimers).toBe(0);
      expect(timing.openPorts).toBe(0);
    },
  );

  it("uses the live slice profile and cancels an aborted task wait", async () => {
    const timing = new ManualWorkerTiming();
    const { workScheduler, updateSchedulingProfile } = createWorkerWorkScheduler(
      { frameIntervalMilliseconds: 1_000 / 120, sliceMilliseconds: 4 },
      timing,
    );
    workScheduler.deadline();
    timing.time = 4;
    const wait = workScheduler.checkpoint();
    updateSchedulingProfile(2, 1_000 / 240);
    timing.runNextTask();
    timing.runNextTask();
    await wait;
    expect(workScheduler.deadline()).toBe(6);

    timing.time = 6;
    const controller = new AbortController();
    const aborted = workScheduler.checkpoint(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(aborted).rejects.toThrow("cancelled");
    workScheduler.dispose();
    expect(timing.pendingTimers).toBe(0);
  });
});

describe("worker task transport fallback", () => {
  it.each(["absent", "construction-failure", "post-failure"] as const)(
    "uses cancellable timers when the channel is %s",
    async (channelMode) => {
      const timing = new ManualWorkerTiming();
      timing.channelMode = channelMode;
      const { workScheduler } = createWorkerWorkScheduler(
        { frameIntervalMilliseconds: 8, sliceMilliseconds: 4 },
        timing,
      );
      workScheduler.deadline();
      timing.time = 4;
      const wait = workScheduler.checkpoint();
      timing.runNextTask();
      timing.runNextTask();
      await wait;
      expect(timing.delays.every((delay) => delay === 0)).toBe(true);
      expect(timing.channelAttempts).toBe(1);
      expect(timing.openPorts).toBe(0);
      workScheduler.dispose();
      expect(timing.pendingTimers).toBe(0);
    },
  );
});

describe("native worker task transport lifecycle", () => {
  it("owns and closes native worker ports on runtime termination", async () => {
    const timing = new ManualWorkerTiming();
    let receive: (() => void) | null = null;
    const closes = vi.fn();
    vi.stubGlobal("self", { setTimeout: timing.setTimer, clearTimeout: timing.clearTimer });
    vi.stubGlobal("performance", { now: timing.now });
    vi.stubGlobal(
      "MessageChannel",
      class {
        readonly #channel = timing.openChannel(() => receive?.());
        public readonly port1 = {
          set onmessage(callback: (() => void) | null) {
            receive = callback;
          },
          close: closes,
        };
        public readonly port2 = {
          postMessage: () => this.#channel?.post(),
          close: () => {
            closes();
            this.#channel?.close();
          },
        };
      },
    );
    const scheduling = createWorkerWorkScheduler({
      frameIntervalMilliseconds: 8,
      sliceMilliseconds: 4,
    });
    const runtime = createProductionDocumentRuntime(
      { sessionId: "session", workerEpoch: 1 },
      scheduling,
    );
    expect(timing.channelAttempts).toBe(0);
    scheduling.workScheduler.deadline();
    timing.time = 4;
    const wait = runtime.checkpoint(new AbortController().signal);
    expect(timing.openPorts).toBe(2);
    runtime.terminate();
    runtime.terminate();
    await expect(wait).rejects.toThrow();
    expect(receive).toBeNull();
    expect(closes).toHaveBeenCalledTimes(2);
    expect(timing.openPorts).toBe(0);
    expect(timing.pendingTimers).toBe(0);
    timing.runNextTask();
    expect(timing.pendingMessages).toBe(0);
  });

  it("uses the native timer fallback when the worker has no MessageChannel", () => {
    const timing = new ManualWorkerTiming();
    vi.stubGlobal("self", { setTimeout: timing.setTimer, clearTimeout: timing.clearTimer });
    vi.stubGlobal("performance", { now: timing.now });
    vi.stubGlobal("MessageChannel", undefined);
    const { workScheduler } = createWorkerWorkScheduler({
      frameIntervalMilliseconds: 8,
      sliceMilliseconds: 4,
    });
    workScheduler.deadline();
    expect(timing.delays).toEqual([0]);
    timing.runNextTask();
    expect(timing.pendingTimers).toBe(0);
    workScheduler.dispose();
    expect(timing.openPorts).toBe(0);
  });
});
