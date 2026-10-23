import { expect, it, vi } from "vitest";
import { SharedFrameScheduler } from "../../../../../src/domain/scheduling/shared-frame-scheduler";
import { HostZoomMeasureThrottle } from "../../../../../src/obsidian/embeds/live-preview/host-zoom-measure-throttle";
import { ManualHost } from "../../../../fixtures/scheduling/manual-frame-host";

function createThrottleHarness() {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const timers: Array<() => void> = [];
  const ownerWindow = {
    setTimeout: vi.fn((callback: () => void) => timers.push(callback)),
    clearTimeout: vi.fn(),
  };
  const throttle = new HostZoomMeasureThrottle(ownerWindow as unknown as Window, scheduler);
  const callback = vi.fn();
  return { host, scheduler, timers, ownerWindow, throttle, callback };
}

it("uses the owning timer and central clock, retaining central budget admission", () => {
  const { host, scheduler, timers, ownerWindow, throttle, callback } = createThrottleHarness();
  try {
    throttle.request(callback);
    expect(callback).toHaveBeenCalledOnce();
    host.time = 20;
    throttle.request(callback);
    expect(ownerWindow.setTimeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 130);
    host.time = 150;
    scheduler.deadline();
    host.time = 154;
    expect(scheduler.shouldYield()).toBe(true);
    timers[0]!();
    expect(callback).toHaveBeenCalledOnce();
    host.frame(154);
    expect(callback).toHaveBeenCalledOnce();
    host.time = 158;
    host.frame(158);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(host.pendingFrames).toBe(0);
  } finally {
    throttle.cancel();
    scheduler.dispose();
  }
});

it("ignores canceled timers and admitted frames from an earlier generation", () => {
  const { host, scheduler, timers, ownerWindow, throttle, callback } = createThrottleHarness();
  const frame = vi.spyOn(scheduler, "requestFrame");
  try {
    throttle.request(callback);
    throttle.request(callback);
    throttle.cancel();
    expect(ownerWindow.clearTimeout).toHaveBeenCalledExactlyOnceWith(1);
    timers[0]!();
    expect(frame).not.toHaveBeenCalled();
    throttle.request(callback);
    timers[1]!();
    const obsoleteFrame = frame.mock.calls[0]![0];
    throttle.cancel();
    obsoleteFrame(150);
    expect(callback).toHaveBeenCalledOnce();
    expect(host.pendingFrames).toBe(0);
  } finally {
    throttle.cancel();
    scheduler.dispose();
  }
});
