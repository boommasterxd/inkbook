import { afterEach, expect, it, vi } from "vitest";

import { RequestWatchdog } from "../../../../../../src/persistence/worker/runtime/bridge/request-timeout";

afterEach(() => vi.useRealTimers());

it("retains the remaining active deadline across overlapping scheduler and input pauses", async () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const watchdog = new RequestWatchdog(expired, 100, () => Date.now());
  await vi.advanceTimersByTimeAsync(40);
  watchdog.setGatePaused(true);
  let resume!: () => void;
  const admission = watchdog.waitForAdmission(new Promise((resolve) => (resume = resolve)));
  await vi.advanceTimersByTimeAsync(500);
  watchdog.setGatePaused(false);
  expect(vi.getTimerCount()).toBe(0);
  resume();
  await admission;
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(59);
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expired).toHaveBeenCalledOnce();
  watchdog.setGatePaused(true);
  watchdog.setGatePaused(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("releases the timer on cancellation and never rearms when a pending admission settles", async () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const watchdog = new RequestWatchdog(expired, 100, () => Date.now());
  let reject!: (reason: Error) => void;
  const admission = watchdog.waitForAdmission(new Promise((_, failed) => (reject = failed)));
  watchdog.cancel();
  reject(new Error("aborted"));
  await expect(admission).rejects.toThrow("aborted");
  watchdog.setGatePaused(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(expired).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps cumulative active time bounded even when the same gate is repeatedly notified", async () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const watchdog = new RequestWatchdog(expired, 100, () => Date.now());
  for (let index = 0; index < 4; index += 1) {
    await vi.advanceTimersByTimeAsync(20);
    watchdog.setGatePaused(true);
    watchdog.setGatePaused(true);
    await vi.advanceTimersByTimeAsync(1000);
    watchdog.setGatePaused(false);
    watchdog.setGatePaused(false);
  }
  await vi.advanceTimersByTimeAsync(20);
  expect(expired).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("never extends the remaining deadline when an injected clock moves backwards", async () => {
  vi.useFakeTimers();
  let time = 100;
  const expired = vi.fn();
  const watchdog = new RequestWatchdog(expired, 100, () => time);
  time = 0;
  watchdog.setGatePaused(true);
  await vi.advanceTimersByTimeAsync(500);
  watchdog.setGatePaused(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(expired).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
