import { expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../src/domain/scheduling/shared-frame-scheduler";
import { ManualHost } from "../../fixtures/scheduling/manual-frame-host";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

const profile = INTERACTION_REFRESH_PROFILE;

it(`bounds 10,000 competing callbacks by one shared ${profile.refreshRate} Hz budget`, () => {
  const host = new ManualHost();
  host.budget = profile.interruptibleSliceDeadlineMs;
  host.frameInterval = profile.frameDurationMs;
  const scheduler = new SharedFrameScheduler(host);
  let admitted = 0;
  for (let index = 0; index < 10_000; index += 1) {
    scheduler.requestFrame(() => {
      admitted += 1;
      host.time += 0.1;
    });
  }
  expect(host.pendingFrames).toBe(1);
  expect(host.pendingTimers).toBe(1);
  const maxPerFrame = Math.ceil(host.budget / 0.1);
  let frames = 0;
  while (admitted < 10_000) {
    const before = admitted;
    host.frame();
    frames += 1;
    expect(admitted - before).toBeGreaterThan(0);
    expect(admitted - before).toBeLessThanOrEqual(maxPerFrame);
    expect(host.pendingFrames).toBeLessThanOrEqual(1);
    expect(host.pendingTimers).toBeLessThanOrEqual(2);
    host.timer(0);
    host.time += profile.frameDurationMs;
  }
  expect(frames).toBeGreaterThan(1);
  expect(admitted).toBe(10_000);
  expect(host.frameRequests).toBe(frames);
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
  scheduler.dispose();
});

it("releases a cancelled 10,000-callback queue and reuses the scheduler", () => {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const run = vi.fn();
  const handles = Array.from({ length: 10_000 }, () => scheduler.requestFrame(run));
  expect(host.pendingFrames).toBe(1);
  expect(host.pendingTimers).toBe(1);
  for (const handle of handles) scheduler.cancelFrame(handle);
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
  host.frame();
  expect(run).not.toHaveBeenCalled();
  scheduler.requestFrame(run);
  host.frame();
  expect(run).toHaveBeenCalledOnce();
  scheduler.dispose();
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});
