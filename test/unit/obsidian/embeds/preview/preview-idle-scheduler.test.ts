import { expect, it, vi } from "vitest";
import { SharedFrameScheduler } from "../../../../../src/domain/scheduling/shared-frame-scheduler";
import { PreviewIdleScheduler } from "../../../../../src/obsidian/embeds/preview/preview-idle-scheduler";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { ManualHost } from "../../../../fixtures/scheduling/manual-frame-host";

function fixture() {
  let releaseBudget: (() => void) | undefined;
  const checkpoint = vi.fn(
    (signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new Error("aborted"));
          return;
        }
        const onAbort = () => reject(new Error("aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
        releaseBudget = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      }),
  );
  const nextFrame = vi.fn(async () => {});
  const scheduler = new PreviewIdleScheduler({
    ...immediateWorkScheduler(),
    checkpoint,
    nextFrame,
  });
  return { checkpoint, nextFrame, scheduler, releaseBudget: () => releaseBudget?.() };
}

it("starts the initial bounded slice after the input gate without a frame handoff", async () => {
  const checkpoint = vi.fn(() => undefined);
  const nextFrame = vi.fn(async () => {});
  const scheduler = new PreviewIdleScheduler({
    ...immediateWorkScheduler(),
    checkpoint,
    nextFrame,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  scheduler.setBackgroundWait(() => gate);
  const initial = scheduler.checkpoint(true);
  await Promise.resolve();
  expect(checkpoint).not.toHaveBeenCalled();
  release();
  await initial;
  expect(checkpoint).toHaveBeenCalledOnce();
  expect(nextFrame).not.toHaveBeenCalled();
  scheduler.dispose();
});

it("waits for the shared deadline when the initial slice is already exhausted", async () => {
  let release!: () => void;
  const checkpoint = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const scheduler = new PreviewIdleScheduler({ ...immediateWorkScheduler(), checkpoint });
  let completed = false;
  const initial = scheduler.checkpoint(true)!.then(() => {
    completed = true;
  });
  await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
  expect(completed).toBe(false);
  release();
  await initial;
  expect(completed).toBe(true);
  scheduler.dispose();
});

it("waits only for an exhausted shared budget and checks input again afterward", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let input = false;
  f.scheduler.setBackgroundWait(() => (input ? gate : Promise.resolve()));
  const continuation = f.scheduler.checkpoint();
  await vi.waitFor(() => expect(f.checkpoint).toHaveBeenCalledOnce());
  input = true;
  f.releaseBudget();
  let completed = false;
  void continuation!.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  release();
  await continuation;
  expect(completed).toBe(true);
  expect(f.nextFrame).not.toHaveBeenCalled();
  f.scheduler.dispose();
});

it("releases waiting input and scheduled budget continuations on disposal", async () => {
  const f = fixture();
  f.scheduler.setBackgroundWait(() => new Promise<void>(() => undefined));
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const gate = f.scheduler.waitForBackground(controller.signal);
  controller.abort();
  await gate;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  f.scheduler.setBackgroundWait(undefined);
  const frame = f.scheduler.checkpoint();
  await vi.waitFor(() => expect(f.checkpoint).toHaveBeenCalledOnce());
  f.scheduler.dispose();
  await frame;
  expect(f.nextFrame).not.toHaveBeenCalled();
});

it("propagates shared scheduler failures while the preview is live", async () => {
  const scheduler = new PreviewIdleScheduler({
    ...immediateWorkScheduler(),
    checkpoint: () => Promise.reject(new Error("closed window")),
  });
  await expect(scheduler.checkpoint()).rejects.toThrow("closed window");
  scheduler.dispose();
});

it("keeps idle gates and available shared admission synchronous", () => {
  const checkpoint = vi.fn(() => undefined);
  const gate = vi.fn(() => undefined);
  const scheduler = new PreviewIdleScheduler({ ...immediateWorkScheduler(), checkpoint });
  scheduler.setBackgroundWait(gate);
  expect(scheduler.waitForBackground()).toBeUndefined();
  expect(scheduler.checkpoint()).toBeUndefined();
  expect(checkpoint).toHaveBeenCalledOnce();
  scheduler.dispose();
  expect(scheduler.checkpoint()).toBeUndefined();
});

it("removes a superseded admission without cancelling the replacement queued before it settles", async () => {
  const host = new ManualHost();
  const workScheduler = new SharedFrameScheduler(host);
  const checkpoint = vi.spyOn(workScheduler, "checkpoint");
  const cancelFrame = vi.spyOn(host, "cancelFrame");
  const scheduler = new PreviewIdleScheduler(workScheduler);
  host.time = workScheduler.deadline();
  const obsolete = new AbortController();
  const pending = scheduler.checkpoint(false, obsolete.signal);
  const settled = expect(pending).rejects.toThrow("Superseded preview.");
  const obsoleteSignal = checkpoint.mock.calls[0]![0]!;
  const remove = vi.spyOn(obsoleteSignal, "removeEventListener");
  expect(host.pendingFrames).toBe(1);
  obsolete.abort(new Error("Superseded preview."));
  expect(host.pendingFrames).toBe(0);
  expect(host.hasTimer(50)).toBe(false);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  const replacement = new AbortController();
  const current = scheduler.checkpoint(false, replacement.signal);
  await settled;
  expect(cancelFrame).toHaveBeenCalledOnce();
  expect(host.frameRequests).toBe(2);
  expect(host.pendingFrames).toBe(1);
  expect(checkpoint.mock.calls[1]![0]!.aborted).toBe(false);
  host.time = host.frameInterval;
  host.frame();
  await current;
  scheduler.dispose();
  workScheduler.dispose();
  expect(host.pendingTimers).toBe(0);
});

it.each(["success", "error", "dispose"] as const)(
  "releases the linked admission listener and scheduler resources after %s",
  async (outcome) => {
    const host = new ManualHost();
    const workScheduler = new SharedFrameScheduler(host);
    const checkpoint = vi.spyOn(workScheduler, "checkpoint");
    const scheduler = new PreviewIdleScheduler(workScheduler);
    const operation = new AbortController();
    host.time = workScheduler.deadline();
    const pending = scheduler.checkpoint(false, operation.signal);
    const signal = checkpoint.mock.calls[0]![0]!;
    const remove = vi.spyOn(signal, "removeEventListener");
    const settled =
      outcome === "error"
        ? expect(pending).rejects.toThrow("disposed")
        : expect(pending).resolves.toBeUndefined();
    if (outcome === "success") {
      host.time = host.frameInterval;
      host.frame();
    } else if (outcome === "error") workScheduler.dispose();
    else scheduler.dispose();
    await settled;
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
    expect(host.pendingFrames).toBe(0);
    expect(host.hasTimer(50)).toBe(false);
    operation.abort();
    expect(remove).toHaveBeenCalledOnce();
    scheduler.dispose();
    workScheduler.dispose();
    expect(host.pendingTimers).toBe(0);
  },
);
