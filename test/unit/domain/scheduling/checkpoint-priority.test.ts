import { expect, it } from "vitest";

import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import { SchedulerDisposedError } from "../../../../src/domain/scheduling/work-scheduler";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";

it("keeps every checkpoint priority synchronous without enqueueing while budget remains", () => {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const deadline = scheduler.deadline();
  const timers = host.timerRequests;
  for (const priority of ["input", "frame", "background"] as const) {
    expect(scheduler.checkpoint(undefined, priority)).toBeUndefined();
    expect(scheduler.deadline()).toBe(deadline);
  }
  expect(host.frameRequests).toBe(0);
  expect(host.timerRequests).toBe(timers);
  scheduler.dispose();
  expect(host.pendingTimers).toBe(0);
});

it("cancels a prioritized exhausted checkpoint and rejects prioritized waits after disposal", async () => {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  host.time = scheduler.deadline();
  const controller = new AbortController();
  const pending = scheduler.checkpoint(controller.signal, "frame");
  expect(host.pendingFrames).toBe(1);
  controller.abort(new Error("Stopped prioritized preparation."));
  await expect(pending).rejects.toThrow("Stopped prioritized preparation.");
  expect(host.pendingFrames).toBe(0);
  scheduler.dispose();
  await expect(scheduler.checkpoint(undefined, "frame")).rejects.toBeInstanceOf(
    SchedulerDisposedError,
  );
  expect(host.pendingTimers).toBe(0);
});

it("admits an input checkpoint before an older frame checkpoint", async () => {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  host.time = scheduler.deadline();
  const order: string[] = [];
  const frame = scheduler.checkpoint(undefined, "frame")?.then(() => order.push("frame"));
  const input = scheduler.checkpoint(undefined, "input")?.then(() => order.push("input"));
  host.time = host.frameInterval;
  host.frame();
  await input;
  expect(order).toEqual(["input"]);
  while (host.hasTimer(0)) host.timer(0);
  await frame;
  expect(order).toEqual(["input", "frame"]);
  scheduler.dispose();
  expect(host.pendingTimers).toBe(0);
});
