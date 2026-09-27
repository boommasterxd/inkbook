import { expect, it, vi } from "vitest";
import { PreviewIdleScheduler } from "../../../../src/obsidian/embeds/preview-idle-scheduler";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

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
  const initial = scheduler.checkpoint(true).then(() => {
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
  void continuation.then(() => {
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
