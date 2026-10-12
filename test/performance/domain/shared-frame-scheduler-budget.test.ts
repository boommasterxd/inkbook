import { expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../src/domain/scheduling/shared-frame-scheduler";
import { ManualHost } from "../../fixtures/scheduling/manual-frame-host";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { GestureAwareSliceScheduler } from "../../../src/persistence/worker/runtime/slice-scheduler";
import { createMainThreadCheckpoint } from "../../../src/persistence/scheduling/main-thread-checkpoint";

const profile = INTERACTION_REFRESH_PROFILE;

it(`preserves synchronous admission, shared exhaustion, and input cancellation at ${profile.refreshRate} Hz`, async () => {
  const host = new ManualHost();
  host.budget = profile.interruptibleSliceDeadlineMs;
  host.frameInterval = profile.frameDurationMs;
  const scheduler = new SharedFrameScheduler(host);
  const worker = new GestureAwareSliceScheduler({
    isInputActive: () => false,
    workScheduler: scheduler,
  });
  const signal = new AbortController().signal;
  const checkpoint = createMainThreadCheckpoint(scheduler, () => undefined);
  for (let index = 0; index < 10_000; index += 1) {
    expect(checkpoint()).toBeUndefined();
    expect(worker.checkpoint(signal)).toBeUndefined();
  }
  expect(host.frameRequests).toBe(0);
  expect(host.pendingTimers).toBe(1);
  worker.setLiveInputActive(true);
  const controller = new AbortController();
  const held = worker.checkpoint(controller.signal);
  expect(held).toBeInstanceOf(Promise);
  controller.abort(new Error("cancelled input wait"));
  await expect(held).rejects.toThrow("cancelled input wait");
  worker.setLiveInputActive(false);
  host.time = host.budget;
  const exhausted = worker.checkpoint(signal);
  expect(exhausted).toBeInstanceOf(Promise);
  expect(host.pendingFrames).toBe(1);
  scheduler.dispose();
  await expect(exhausted).rejects.toThrow();
  expect(host.pendingTimers).toBe(0);
  expect(host.pendingFrames).toBe(0);
});

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

it(`bounds 10,000 task-admitted callbacks at ${profile.refreshRate} Hz without frame waits`, () => {
  const host = new ManualHost();
  host.continuationMode = "task";
  host.budget = profile.interruptibleSliceDeadlineMs;
  host.frameInterval = profile.frameDurationMs;
  const scheduler = new SharedFrameScheduler(host);
  expect(scheduler.deadline()).toBe(host.budget);
  host.time = host.budget;
  expect(scheduler.shouldYield()).toBe(true);
  expect(scheduler.deadline()).toBe(host.budget);

  let admitted = 0;
  for (let index = 0; index < 10_000; index += 1) {
    scheduler.requestFrame(() => {
      admitted += 1;
      host.time += 0.1;
    }, "background");
  }
  const maxPerTask = Math.ceil(host.budget / 0.1);
  let taskTurns = 0;
  while (admitted < 10_000) {
    const before = admitted;
    for (let turn = 0; turn < 3 && admitted === before; turn += 1) host.timer(0);
    taskTurns += 1;
    expect(admitted - before).toBeGreaterThan(0);
    expect(admitted - before).toBeLessThanOrEqual(maxPerTask);
    expect(host.pendingFrames).toBe(0);
    expect(host.pendingTimers).toBeLessThanOrEqual(2);
  }
  expect(taskTurns).toBeGreaterThan(1);
  expect(host.frameRequests).toBe(0);
  expect(host.timerRequests).toBeLessThanOrEqual(2 * taskTurns + 1);
  expect(host.pendingTimers).toBe(1);
  host.timer(0);
  expect(host.pendingTimers).toBe(0);
  const timerRequests = host.timerRequests;
  host.time += host.frameInterval;
  expect(host.timerRequests).toBe(timerRequests);
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

it(`admits required checkpoint work fairly beside a recurring full ${profile.refreshRate} Hz frame`, async () => {
  const host = new ManualHost();
  host.budget = profile.interruptibleSliceDeadlineMs;
  host.frameInterval = profile.frameDurationMs;
  const scheduler = new SharedFrameScheduler(host);
  host.time = scheduler.deadline();
  const order: string[] = [];
  const background = scheduler.checkpoint()?.then(() => order.push("default"));
  const explicitBackground = scheduler
    .checkpoint(undefined, "background")
    ?.then(() => order.push("background"));
  let renderHandle = 0;
  const render = (): void => {
    order.push("render");
    host.time += host.budget;
    renderHandle = scheduler.requestFrame(render);
  };
  renderHandle = scheduler.requestFrame(render);
  const required = ["first", "second"].map((name) => {
    const pending = scheduler.checkpoint(undefined, "frame");
    if (pending === undefined) throw new Error("Exhausted required work must await admission.");
    return pending.then(() => {
      order.push(name);
      host.time += host.budget;
    });
  });
  for (let frame = 1; frame <= 3; frame++) {
    host.time = frame * host.frameInterval;
    host.frame();
    await Promise.resolve();
    while (host.hasTimer(0)) {
      host.timer(0);
      await Promise.resolve();
    }
    expect(host.pendingFrames).toBeLessThanOrEqual(1);
    expect(host.pendingTimers).toBeLessThanOrEqual(1);
  }
  await Promise.all(required);
  expect(order).toEqual(["render", "first", "second"]);
  scheduler.cancelFrame(renderHandle);
  host.time = 4 * host.frameInterval;
  host.frame();
  await background;
  while (host.hasTimer(0)) {
    host.timer(0);
    await Promise.resolve();
  }
  await explicitBackground;
  expect(order).toEqual(["render", "first", "second", "default", "background"]);
  scheduler.dispose();
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});
