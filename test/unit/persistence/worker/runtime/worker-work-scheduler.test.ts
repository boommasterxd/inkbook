import { describe, expect, it } from "vitest";

import {
  createWorkerWorkScheduler,
  type WorkerTimingPort,
} from "../../../../../src/persistence/worker/runtime/worker-work-scheduler";

class ManualWorkerTiming implements WorkerTimingPort {
  public time = 0;
  public readonly delays: number[] = [];
  readonly #timers = new Map<number, { callback: () => void; delay: number }>();
  #nextHandle = 0;

  public now = (): number => this.time;
  public setTimeout = (callback: () => void, delay: number): number => {
    const handle = ++this.#nextHandle;
    this.delays.push(delay);
    this.#timers.set(handle, { callback, delay });
    return handle;
  };
  public clearTimeout = (handle: number): void => {
    this.#timers.delete(handle);
  };

  public runNextTask(): void {
    const next = this.#timers.entries().next().value;
    if (next === undefined) throw new Error("No worker task is pending.");
    const [handle, { callback, delay }] = next;
    expect(delay).toBe(0);
    this.#timers.delete(handle);
    callback();
  }

  public get pendingTimers(): number {
    return this.#timers.size;
  }
}

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
      expect(timing.delays.every((delay) => delay === 0)).toBe(true);
      expect(workScheduler.deadline()).toBeCloseTo(sliceMilliseconds * 2);
      await wait;
      expect(timing.pendingTimers).toBe(1);
      timing.runNextTask();
      expect(timing.pendingTimers).toBe(0);
      workScheduler.dispose();
      expect(timing.pendingTimers).toBe(0);
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
