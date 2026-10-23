import { describe, expect, it, vi } from "vitest";

import { MutationPreparationScheduler } from "../../../../../src/domain/store/mutations/mutation-preparation-scheduler";

describe("mutation preparation scheduling", () => {
  it.each([0, 2_049])(
    "completes %s actual generator steps synchronously within the shared budget",
    (count) => {
      const yieldControl = vi.fn(async () => undefined);
      const scheduler = new MutationPreparationScheduler({
        shouldYield: () => false,
        yieldControl,
      });
      const visit = vi.fn();
      const steps = countingSteps(count, visit);
      const next = vi.spyOn(steps, "next");
      expect(scheduler.run(steps)).toBe(count);
      expect(visit).toHaveBeenCalledTimes(count);
      expect(next).toHaveBeenCalledTimes(count + 1);
      expect(yieldControl).not.toHaveBeenCalled();
    },
  );

  it("honors the shared deadline before starting work", async () => {
    const yieldControl = vi.fn(async () => undefined);
    const scheduler = new MutationPreparationScheduler({ shouldYield: () => true, yieldControl });
    expect(scheduler.checkpoint()).toBe(false);
    expect(yieldControl).not.toHaveBeenCalled();
    expect(await scheduler.resume()).toBe(true);
    expect(yieldControl).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "cancels before or during a yield: initially cancelled=%s",
    async (initial) => {
      let cancelled = initial;
      const yieldControl = vi.fn(async () => {
        cancelled = true;
      });
      const scheduler = new MutationPreparationScheduler({
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl,
      });
      expect(scheduler.checkpoint()).toBe(false);
      expect(await scheduler.resume()).toBe(false);
      expect(yieldControl).toHaveBeenCalledTimes(initial ? 0 : 1);
    },
  );
});

describe("mutation preparation synchronous continuation", () => {
  it("shares the absolute deadline across runs and resumes only after central admission", async () => {
    let time = 0;
    let deadline = 4;
    let release: () => void = () => undefined;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const yieldControl = vi.fn(() => admission);
    const scheduler = new MutationPreparationScheduler({
      shouldYield: () => time >= deadline,
      yieldControl,
    });
    const charge = vi.fn(() => {
      time += 2;
    });
    expect(scheduler.run(countingSteps(1, charge))).toBe(1);
    const pending = scheduler.run(countingSteps(2, charge));
    expect(pending).toBeInstanceOf(Promise);
    expect(charge).toHaveBeenCalledTimes(2);
    expect(yieldControl).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(charge).toHaveBeenCalledTimes(2);
    deadline = 8;
    release();
    expect(await pending).toBe(2);
    expect(charge).toHaveBeenCalledTimes(3);
    expect(yieldControl).toHaveBeenCalledTimes(1);
  });

  it.each(["before", "step", "yield"] as const)(
    "stops actual generator visits when cancelled during %s",
    async (phase) => {
      let cancelled = phase === "before";
      const visit = vi.fn(() => {
        cancelled = phase === "step";
      });
      const yieldControl = vi.fn(async () => {
        cancelled = true;
      });
      const scheduler = new MutationPreparationScheduler({
        isCancelled: () => cancelled,
        shouldYield: () => phase === "yield",
        yieldControl,
      });
      const result = scheduler.run(countingSteps(3, visit));
      if (phase !== "yield") expect(result).toBe("cancelled");
      expect(await result).toBe("cancelled");
      expect(visit).toHaveBeenCalledTimes(phase === "step" ? 1 : 0);
      expect(yieldControl).toHaveBeenCalledTimes(phase === "yield" ? 1 : 0);
    },
  );

  it("propagates generator errors synchronously or after a real yield", async () => {
    const error = new Error("Preparation failed.");
    const visit = () => {
      throw error;
    };
    for (const yielded of [false, true]) {
      const scheduler = new MutationPreparationScheduler({
        shouldYield: () => yielded,
        yieldControl: async () => undefined,
      });
      const run = () => scheduler.run(countingSteps(1, visit));
      if (yielded) await expect(run()).rejects.toBe(error);
      else expect(run).toThrow(error);
    }
    const scheduler = new MutationPreparationScheduler({
      shouldYield: () => true,
      yieldControl: () => Promise.reject(error),
    });
    const untouched = vi.fn();
    await expect(scheduler.run(countingSteps(1, untouched))).rejects.toBe(error);
    expect(untouched).not.toHaveBeenCalled();
  });

  it("drains repeated central handoffs with exactly one admitted step per resume", async () => {
    const yieldControl = vi.fn(async () => undefined);
    const work = new MutationPreparationScheduler({ shouldYield: () => true, yieldControl });
    const visit = vi.fn();
    const steps = countingSteps(128, visit);
    const next = vi.spyOn(steps, "next");
    const pending = work.run(steps);
    expect(visit).not.toHaveBeenCalled();
    expect(yieldControl).toHaveBeenCalledTimes(1);
    expect(await pending).toBe(128);
    expect(visit).toHaveBeenCalledTimes(128);
    expect(next).toHaveBeenCalledTimes(129);
    expect(yieldControl).toHaveBeenCalledTimes(129);
  });
});

function* countingSteps(count: number, visit: () => void): Generator<void, number> {
  for (let index = 0; index < count; index += 1) {
    visit();
    yield;
  }
  return count;
}
