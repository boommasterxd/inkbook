import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";
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

  it.each([60, 90, 120, 144, 240])("shares real scheduler checkpoints at %i Hz", async (hz) => {
    const wall = vi.spyOn(performance, "now").mockImplementation(() => {
      throw new Error("Controlled deadlines must not read wall time.");
    });
    const host = new ManualHost();
    host.budget = (1000 / hz) * 0.55;
    host.frameInterval = 1000 / hz;
    const workScheduler = new SharedFrameScheduler(host);
    const scheduler = new GestureAwareSliceScheduler({
      isInputActive: () => false,
      workScheduler,
    });
    const signal = new AbortController().signal;
    for (let slice = 0; slice < 3; slice += 1) {
      await scheduler.checkpoint(signal);
      const deadline = workScheduler.deadline();
      host.time = deadline - 0.01;
      await scheduler.checkpoint(signal);
      expect(host.frameRequests).toBe(slice);
      host.time = deadline;
      const pending = scheduler.checkpoint(signal);
      await Promise.resolve();
      expect(host.frameRequests).toBe(slice + 1);
      host.time = (slice + 1) * host.frameInterval;
      host.frame();
      await pending;
    }
    expect(scheduler.getSliceMilliseconds()).toBe(host.budget);
    expect(wall).not.toHaveBeenCalled();
    workScheduler.dispose();
  });

  it("waits for input release without polling and cancels before clock reads", async () => {
    const host = new ManualHost();
    const now = vi.spyOn(host, "now");
    const workScheduler = new SharedFrameScheduler(host);
    const scheduler = new GestureAwareSliceScheduler({
      isInputActive: () => false,
      workScheduler,
    });
    scheduler.setLiveInputActive(true);
    const controller = new AbortController();
    const waiting = scheduler.checkpoint(controller.signal);
    await Promise.resolve();
    expect(now).not.toHaveBeenCalled();
    expect(host.pendingFrames).toBe(0);
    expect(host.pendingTimers).toBe(0);
    scheduler.setLiveInputActive(false);
    await waiting;
    const reads = now.mock.calls.length;
    controller.abort(new Error("cancelled"));
    await expect(scheduler.checkpoint(controller.signal)).rejects.toThrow("cancelled");
    expect(now).toHaveBeenCalledTimes(reads);
    workScheduler.dispose();
  });
});
