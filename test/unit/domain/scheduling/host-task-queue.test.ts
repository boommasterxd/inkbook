import { expect, it, vi } from "vitest";

import { HostTaskQueue } from "../../../../src/domain/scheduling/host-task-queue";
import { ManualTaskPort } from "../../../fixtures/scheduling/manual-task-port";

it("preserves task order, removes cancellations, and reuses one outstanding wake", () => {
  const host = new ManualTaskPort();
  const queue = new HostTaskQueue(host);
  const calls: number[] = [];
  const cancelled = queue.schedule(() => calls.push(0), 0);
  queue.cancel(cancelled);
  queue.cancel(cancelled);
  queue.schedule(() => {
    calls.push(1);
    queue.schedule(() => calls.push(3), 0);
  }, 0);
  queue.schedule(() => calls.push(2), 0);
  expect(host.pendingMessages).toBe(1);
  host.runNextTask();
  expect(calls).toEqual([1]);
  expect(host.pendingMessages).toBe(1);
  host.runNextTask();
  host.runNextTask();
  expect(calls).toEqual([1, 2, 3]);
  expect(host.pendingMessages).toBe(0);
  expect(host.channelAttempts).toBe(1);
  queue.dispose();
  queue.dispose();
  expect(host.openPorts).toBe(0);
  expect(() => queue.schedule(() => undefined, 0)).toThrow("disposed");
});

it("keeps semantic delays on timers and cancels both transport kinds", () => {
  const host = new ManualTaskPort();
  const queue = new HostTaskQueue(host);
  const run = vi.fn();
  queue.schedule(run, 50);
  host.runNextTask();
  expect(run).toHaveBeenCalledOnce();
  run.mockClear();
  const delayed = queue.schedule(run, 50);
  expect(host.channelAttempts).toBe(0);
  expect(host.delays).toEqual([50, 50]);
  queue.cancel(delayed);
  queue.schedule(run, 0);
  queue.schedule(run, 50);
  queue.dispose();
  host.runNextTask();
  expect(run).not.toHaveBeenCalled();
  expect(host.pendingTimers).toBe(0);
  expect(host.pendingMessages).toBe(0);
  expect(host.openPorts).toBe(0);
});

it("continues queued work after a callback throws and transfers failed posts to timers", () => {
  const host = new ManualTaskPort();
  const queue = new HostTaskQueue(host);
  const run = vi.fn();
  queue.schedule(() => {
    host.channelMode = "post-failure";
    throw new Error("Callback failed.");
  }, 0);
  queue.schedule(run, 0);
  queue.schedule(run, 0);
  expect(() => host.runNextTask()).toThrow("Callback failed.");
  expect(host.openPorts).toBe(0);
  expect(host.pendingMessages).toBe(0);
  expect(host.pendingTimers).toBe(2);
  host.runNextTask();
  expect(run).toHaveBeenCalledOnce();
  queue.dispose();
  expect(host.pendingTimers).toBe(0);
});

it("ignores a timer already dispatched before cancellation or disposal", () => {
  const pending: Array<() => void> = [];
  const queue = new HostTaskQueue({
    setTimer: (callback) => pending.push(callback),
    clearTimer: () => undefined,
  });
  const run = vi.fn();
  const cancelled = queue.schedule(run, 0);
  queue.cancel(cancelled);
  queue.schedule(run, 0);
  queue.dispose();
  for (const callback of pending) callback();
  expect(run).not.toHaveBeenCalled();
});
