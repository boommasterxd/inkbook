import { expect, it, vi } from "vitest";
import { PreviewIdleScheduler } from "../../../../src/obsidian/embeds/preview-idle-scheduler";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

function fixture() {
  let releaseFrame: (() => void) | undefined;
  const nextFrame = vi.fn(
    (signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new Error("aborted"));
          return;
        }
        const onAbort = () => reject(new Error("aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
        releaseFrame = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      }),
  );
  const scheduler = new PreviewIdleScheduler({ ...immediateWorkScheduler(), nextFrame });
  return { nextFrame, scheduler, releaseFrame: () => releaseFrame?.() };
}

it("starts the initial bounded slice after the input gate without a frame handoff", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.scheduler.setBackgroundWait(() => gate);
  const initial = f.scheduler.checkpoint(true);
  await Promise.resolve();
  expect(f.nextFrame).not.toHaveBeenCalled();
  release();
  await initial;
  expect(f.nextFrame).not.toHaveBeenCalled();
  f.scheduler.dispose();
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

it("uses the shared frame scheduler and checks input again before continuation", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let input = false;
  f.scheduler.setBackgroundWait(() => (input ? gate : Promise.resolve()));
  const continuation = f.scheduler.checkpoint();
  await vi.waitFor(() => expect(f.nextFrame).toHaveBeenCalledOnce());
  input = true;
  f.releaseFrame();
  let completed = false;
  void continuation.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  release();
  await continuation;
  expect(completed).toBe(true);
  f.scheduler.dispose();
});

it("releases waiting input and scheduled frames on disposal", async () => {
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
  await vi.waitFor(() => expect(f.nextFrame).toHaveBeenCalledOnce());
  f.scheduler.dispose();
  await frame;
});

it("propagates shared scheduler failures while the preview is live", async () => {
  const scheduler = new PreviewIdleScheduler({
    ...immediateWorkScheduler(),
    nextFrame: () => Promise.reject(new Error("closed window")),
  });
  await expect(scheduler.checkpoint()).rejects.toThrow("closed window");
  scheduler.dispose();
});
