import { expect, it, vi } from "vitest";

import { createWorkerWorkScheduler } from "../../../../src/persistence/worker/runtime/worker-work-scheduler";
import { ManualWorkerTiming } from "../../../fixtures/persistence/manual-worker-timing";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

const profile = INTERACTION_REFRESH_PROFILE;

it(`bounds 10,000 competing worker callbacks by shared ${profile.refreshRate} Hz slices and one posted wake`, () => {
  const timing = new ManualWorkerTiming();
  const { workScheduler } = createWorkerWorkScheduler(
    {
      sliceMilliseconds: profile.interruptibleSliceDeadlineMs,
      frameIntervalMilliseconds: profile.frameDurationMs,
    },
    timing,
  );
  let admitted = 0;
  for (let index = 0; index < 10_000; index += 1) {
    workScheduler.requestFrame(() => {
      admitted += 1;
      timing.time += 0.1;
    }, "background");
  }
  expect(timing.pendingMessages).toBe(1);
  expect(timing.openPorts).toBe(2);
  const maxPerSlice = Math.ceil(profile.interruptibleSliceDeadlineMs / 0.1);
  let slices = 0;
  while (admitted < 10_000) {
    const before = admitted;
    for (let turn = 0; turn < 3 && admitted === before; turn += 1) timing.runNextTask();
    slices += 1;
    expect(admitted - before).toBeGreaterThan(0);
    expect(admitted - before).toBeLessThanOrEqual(maxPerSlice);
    expect(timing.pendingMessages).toBeLessThanOrEqual(1);
    expect(timing.pendingTimers).toBe(0);
  }
  expect(slices).toBeGreaterThan(1);
  expect(timing.messagePosts).toBeLessThanOrEqual(2 * slices + 1);
  expect(timing.channelAttempts).toBe(1);
  expect(timing.delays).toEqual([]);
  timing.runNextTask();
  expect(timing.pendingMessages).toBe(0);

  const run = vi.fn();
  const handles = Array.from({ length: 10_000 }, () => workScheduler.requestFrame(run));
  for (const handle of handles) workScheduler.cancelFrame(handle);
  expect(timing.pendingMessages).toBe(1);
  timing.runNextTask();
  expect(run).not.toHaveBeenCalled();
  expect(timing.pendingMessages).toBe(0);
  workScheduler.requestFrame(run, "input");
  timing.runNextTask();
  expect(run).toHaveBeenCalledOnce();
  expect(timing.channelAttempts).toBe(1);
  workScheduler.dispose();
  expect(timing.openPorts).toBe(0);
  expect(timing.pendingTimers).toBe(0);
  timing.runNextTask();
  expect(timing.pendingMessages).toBe(0);
});
