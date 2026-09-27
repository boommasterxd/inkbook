import { describe, expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import { SchedulerDisposedError } from "../../../../src/domain/scheduling/work-scheduler";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";

describe("SharedFrameScheduler", () => {
  it("shares one deadline and defers competing callbacks after the first consumes it", () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    const observed: number[] = [];
    scheduler.requestFrame(() => {
      observed.push(scheduler.deadline());
      host.time = 4;
    });
    scheduler.requestFrame(() => observed.push(scheduler.deadline()));
    host.frame();
    expect(observed).toEqual([4]);
    expect(host.pendingFrames).toBe(1);
    host.timer(0);
    host.time = 8;
    host.frame();
    expect(observed).toEqual([4, 12]);
    expect(host.pendingFrames).toBe(0);
    scheduler.dispose();
    expect(host.pendingTimers).toBe(0);
  });

  it("uses the host frame timestamp and grants only one indivisible over-budget job", () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    const run = vi.fn();
    scheduler.requestFrame(run);
    scheduler.requestFrame(run);
    host.time = 5;
    host.frame(0);
    expect(run).toHaveBeenCalledOnce();
    expect(scheduler.deadline()).toBe(4);
    expect(host.pendingFrames).toBe(1);
    scheduler.dispose();
  });

  it("admits newly queued visual work only in the following epoch", () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    const calls: number[] = [];
    scheduler.requestFrame(() => {
      calls.push(1);
      scheduler.requestFrame(() => calls.push(2));
    });
    host.frame();
    expect(calls).toEqual([1]);
    host.timer(0);
    host.frame();
    expect(calls).toEqual([1, 2]);
    scheduler.dispose();
  });

  it("uses the live budget without allocating a promise or renewing a job deadline", () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    expect(scheduler.checkpoint()).toBeUndefined();
    expect(scheduler.deadline()).toBe(4);
    host.time = 2;
    expect(scheduler.checkpoint()).toBeUndefined();
    expect(scheduler.deadline()).toBe(4);
    host.budget = 3;
    expect(scheduler.deadline()).toBe(3);
    host.budget = 6;
    expect(scheduler.deadline()).toBe(6);
    expect(scheduler.checkpoint()).toBeUndefined();
    expect(host.frameRequests).toBe(0);
    scheduler.dispose();
  });

  it("refreshes an idle epoch only after a complete host task and frame interval", () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    expect(scheduler.deadline()).toBe(4);
    host.time = 9;
    expect(scheduler.shouldYield()).toBe(true);
    host.timer(0);
    expect(scheduler.shouldYield()).toBe(false);
    expect(scheduler.deadline()).toBe(13);
    scheduler.dispose();
  });
});

describe("SharedFrameScheduler admission policy", () => {
  it.each([0, 5])(
    "keeps the first native rAF in its synchronous epoch at timestamp %i ms",
    (timestamp) => {
      const host = new ManualHost();
      const scheduler = new SharedFrameScheduler(host);
      scheduler.deadline();
      host.time = 5;
      const run = vi.fn();
      scheduler.requestFrame(run);
      scheduler.requestFrame(run);
      host.frame(timestamp);
      expect(run).toHaveBeenCalledOnce();
      expect(scheduler.deadline()).toBe(4);
      host.timer(0);
      host.time = 7;
      host.frame(7);
      expect(run).toHaveBeenCalledTimes(2);
      scheduler.dispose();
    },
  );

  it("does not grant another indivisible job after synchronous exhaustion was observed", () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    scheduler.deadline();
    host.time = 4;
    expect(scheduler.shouldYield()).toBe(true);
    const run = vi.fn();
    scheduler.requestFrame(run);
    host.time = 5;
    host.frame(5);
    expect(run).not.toHaveBeenCalled();
    host.timer(0);
    host.time = 8;
    host.frame(8);
    expect(run).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it.each([60, 90, 144])("accepts every subsequent native frame at %i Hz", (rate) => {
    const host = new ManualHost();
    host.frameInterval = 1_000 / rate;
    host.budget = host.frameInterval * 0.55;
    const scheduler = new SharedFrameScheduler(host);
    let completed = 0;
    const run = (): void => {
      completed += 1;
      host.time += host.budget;
      if (completed < 20) scheduler.requestFrame(run);
    };
    scheduler.requestFrame(run);
    for (let frame = 0; frame < 20; frame += 1) {
      const timestamp = Number((frame * host.frameInterval).toFixed(3));
      host.time = timestamp;
      host.frame(timestamp);
      expect(completed).toBe(frame + 1);
      host.timer(0);
    }
    scheduler.dispose();
  });
});

describe("SharedFrameScheduler priorities", () => {
  it("admits input before older background work and then uses remaining time", () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    const order: string[] = [];
    scheduler.requestFrame(() => order.push("background"), "background");
    scheduler.requestFrame(() => order.push("frame"));
    scheduler.requestFrame(() => {
      order.push("input");
      host.time = 1;
    }, "input");
    host.frame();
    expect(order).toEqual(["input", "frame", "background"]);
    expect(host.pendingFrames).toBe(0);
    scheduler.dispose();
  });

  it("defers background work after input spends the shared budget", () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    const order: string[] = [];
    scheduler.requestFrame(() => order.push("background"), "background");
    scheduler.requestFrame(() => {
      order.push("input");
      host.time = 4;
    }, "input");
    host.frame();
    expect(order).toEqual(["input"]);
    host.timer(0);
    host.time = 8;
    host.frame();
    expect(order).toEqual(["input", "background"]);
    scheduler.dispose();
  });
});

describe("SharedFrameScheduler continuation and lifetime", () => {
  it("resumes competing checkpoints one at a time and rechecks spent time", async () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    scheduler.deadline();
    host.time = 4;
    const resumed: number[] = [];
    const first = scheduler.checkpoint()?.then(() => {
      resumed.push(1);
      host.time = 12;
    });
    const second = scheduler.checkpoint()?.then(() => resumed.push(2));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    host.time = 8;
    host.frame();
    await Promise.resolve();
    await Promise.resolve();
    expect(resumed).toEqual([1]);
    host.timer(0);
    host.timer(0);
    expect(host.pendingFrames).toBe(1);
    host.time = 16;
    host.frame();
    await Promise.all([first, second]);
    expect(resumed).toEqual([1, 2]);
    scheduler.dispose();
  });

  it("lets nested await continuations spend the budget before granting another wait", async () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    scheduler.deadline();
    host.time = 4;
    const resumed: number[] = [];
    const first = (async () => {
      await scheduler.checkpoint();
      await Promise.resolve();
      await Promise.resolve();
      host.time = 12;
      resumed.push(1);
    })();
    const second = scheduler.checkpoint()?.then(() => resumed.push(2));
    host.time = 8;
    host.frame();
    await first;
    expect(resumed).toEqual([1]);
    host.timer(0);
    host.timer(0);
    expect(resumed).toEqual([1]);
    host.time = 16;
    host.frame();
    await second;
    expect(resumed).toEqual([1, 2]);
    scheduler.dispose();
  });

  it("grants a second waiter in the same frame when budget remains", async () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    scheduler.deadline();
    host.time = 4;
    const completed: number[] = [];
    const first = scheduler.checkpoint()?.then(() => completed.push(1));
    const second = scheduler.checkpoint()?.then(() => completed.push(2));
    host.time = 8;
    host.frame();
    await first;
    host.timer(0);
    host.timer(0);
    await second;
    expect(completed).toEqual([1, 2]);
    expect(host.frameRequests).toBe(1);
    scheduler.dispose();
  });
});

describe("SharedFrameScheduler fallback and cancellation", () => {
  it("uses a timer when hidden or when visible rAF stalls", async () => {
    const host = new ManualHost();
    host.hidden = true;
    const scheduler = new SharedFrameScheduler(host);
    const hiddenWait = scheduler.nextFrame();
    expect(host.pendingFrames).toBe(0);
    expect(host.pendingTimers).toBe(1);
    host.timer();
    await hiddenWait;
    host.timer(0);
    host.hidden = false;
    const stalledWait = scheduler.nextFrame();
    expect(host.pendingFrames).toBe(1);
    host.timer();
    await stalledWait;
    expect(host.pendingFrames).toBe(0);
    scheduler.dispose();
    expect(host.pendingTimers).toBe(0);
  });

  it("settles aborted and disposed waits and cancels queued callbacks", async () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    const callback = vi.fn();
    const handle = scheduler.requestFrame(callback);
    scheduler.cancelFrame(handle);
    expect(host.pendingFrames).toBe(0);
    const controller = new AbortController();
    const aborted = scheduler.nextFrame(controller.signal);
    controller.abort(new Error("stopped"));
    await expect(aborted).rejects.toThrow("stopped");
    const disposed = scheduler.nextFrame();
    scheduler.dispose();
    await expect(disposed).rejects.toBeInstanceOf(SchedulerDisposedError);
    host.frame();
    expect(callback).not.toHaveBeenCalled();
    expect(host.pendingFrames).toBe(0);
    expect(host.pendingTimers).toBe(0);
  });
});
