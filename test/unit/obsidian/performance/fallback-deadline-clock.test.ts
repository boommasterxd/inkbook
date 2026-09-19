import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestureAwareSliceScheduler } from "../../../../src/persistence/worker/runtime/slice-scheduler";
import { createFallbackDeadlineClock } from "../../../performance/persistence/fallback-deadline-clock";

beforeEach(() => {
  vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_REPORT", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("fallback checkpoint clock", () => {
  it("advances per scheduler observation without reading wall time", () => {
    const wall = vi.spyOn(performance, "now").mockReturnValue(Infinity);
    const now = createFallbackDeadlineClock();
    expect(Array.from({ length: 4 }, now)).toEqual([0.05, 0.1, 0.15, 0.2]);
    expect(createFallbackDeadlineClock()()).toBe(0.05);
    expect(wall).not.toHaveBeenCalled();
  });

  it.each([60, 90, 120, 144, 240])("bounds real scheduler checkpoints at %i Hz", async (hz) => {
    const wall = vi.spyOn(performance, "now").mockImplementation(() => {
      throw new Error("Controlled deadlines must not read wall time.");
    });
    const yieldControl = vi.fn(async () => undefined);
    const budget = (1000 / hz) * 0.55;
    const scheduler = new GestureAwareSliceScheduler({
      isInputActive: () => false,
      now: createFallbackDeadlineClock(),
      sliceMilliseconds: budget,
      yieldControl,
    });
    const signal = new AbortController().signal;
    const checkpointLimit = Math.ceil(budget / 0.05);
    for (let slice = 0; slice < 3; slice += 1) {
      for (let checkpoint = 1; checkpoint < checkpointLimit; checkpoint += 1) {
        await scheduler.checkpoint(signal);
        expect(yieldControl).toHaveBeenCalledTimes(slice);
      }
      await scheduler.checkpoint(signal);
      expect(yieldControl).toHaveBeenCalledTimes(slice + 1);
    }
    expect(scheduler.getSliceMilliseconds()).toBe(budget);
    expect(wall).not.toHaveBeenCalled();
  });

  it("retains input-priority yields and cancellation before later clock reads", async () => {
    let inputQueries = 0;
    const now = vi.fn(createFallbackDeadlineClock());
    const yieldControl = vi.fn(async () => undefined);
    const scheduler = new GestureAwareSliceScheduler({
      isInputActive: () => ++inputQueries <= 2,
      now,
      sliceMilliseconds: 2,
      yieldControl,
    });
    const controller = new AbortController();
    await scheduler.checkpoint(controller.signal);
    expect(yieldControl).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledTimes(4);
    controller.abort(new Error("cancelled"));
    await expect(scheduler.checkpoint(controller.signal)).rejects.toThrow("cancelled");
    expect(now).toHaveBeenCalledTimes(4);
    expect(yieldControl).toHaveBeenCalledTimes(2);
  });
});
