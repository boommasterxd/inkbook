import { expect, it, vi } from "vitest";
import { PreviewIdleScheduler } from "../../../../src/obsidian/embeds/preview-idle-scheduler";

function fixture() {
  let idle: (() => void) | undefined;
  let message: (() => void) | undefined;
  const close = vi.fn();
  const post = vi.fn(() => undefined);
  class Channel {
    public readonly port1 = {
      set onmessage(callback: () => void) {
        message = callback;
      },
      close,
    };
    public readonly port2 = { postMessage: post, close };
  }
  const cancelIdle = vi.fn();
  const requestIdle = vi.fn((callback: () => void) => {
    idle = callback;
    return 1;
  });
  const owner = {
    MessageChannel: Channel,
    requestIdleCallback: requestIdle,
    cancelIdleCallback: cancelIdle,
  } as unknown as Window;
  return {
    scheduler: new PreviewIdleScheduler(owner),
    requestIdle,
    owner,
    close,
    post,
    cancelIdle,
    idle: () => idle?.(),
    message: () => message?.(),
  };
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it("rechecks input after an idle callback and promotes pending idle work on lock", async () => {
  const f = fixture();
  let resume!: () => void;
  let input = false;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  f.scheduler.setBackgroundWait(() => (input ? gate : Promise.resolve()));
  const finished = vi.fn();
  const idleWork = f.scheduler.checkpoint().then(finished);
  await tick();
  await tick();
  expect(f.requestIdle).toHaveBeenCalledOnce();
  input = true;
  f.idle();
  await tick();
  expect(finished).not.toHaveBeenCalled();
  resume();
  await idleWork;
  input = false;
  const pending = f.scheduler.checkpoint();
  await tick();
  await tick();
  f.scheduler.promote();
  await pending;
  expect(f.cancelIdle).toHaveBeenCalledOnce();
  f.scheduler.promote();
  f.scheduler.demote();
  const foreground = f.scheduler.checkpoint();
  await tick();
  await tick();
  expect(f.post).toHaveBeenCalledOnce();
  f.message();
  await foreground;
  expect(f.close).toHaveBeenCalledTimes(2);
  f.scheduler.demote();
  const background = f.scheduler.checkpoint();
  await tick();
  await tick();
  expect(f.requestIdle).toHaveBeenCalledTimes(3);
  f.idle();
  await background;
  f.scheduler.dispose();
});

it("releases waiting input and idle callbacks on dispose, and removes abort listeners", async () => {
  const f = fixture();
  f.scheduler.setBackgroundWait(() => new Promise<void>(() => undefined));
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const aborted = f.scheduler.waitForBackground(controller.signal);
  controller.abort();
  await aborted;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  const disposed = f.scheduler.checkpoint();
  f.scheduler.dispose();
  await disposed;
  expect(f.requestIdle).not.toHaveBeenCalled();
  const idle = fixture();
  const pending = idle.scheduler.checkpoint();
  await tick();
  idle.scheduler.dispose();
  await pending;
  expect(idle.cancelIdle).toHaveBeenCalledOnce();
});

it("closes foreground ports when dispatch fails", async () => {
  const f = fixture();
  f.post.mockImplementation(() => {
    throw new Error("closed window");
  });
  f.scheduler.promote();
  await expect(f.scheduler.checkpoint()).rejects.toThrow("closed window");
  expect(f.close).toHaveBeenCalledTimes(2);
  f.scheduler.dispose();
  expect(f.close).toHaveBeenCalledTimes(2);
});

it("uses owning-window timers when idle callbacks and message channels are unavailable", async () => {
  let callback!: () => void;
  const timer = vi.fn((task: () => void) => {
    callback = task;
    return 42;
  });
  const clear = vi.fn();
  const scheduler = new PreviewIdleScheduler({
    setTimeout: timer,
    clearTimeout: clear,
  } as unknown as Window);
  const idle = scheduler.checkpoint();
  await tick();
  expect(timer).toHaveBeenLastCalledWith(expect.any(Function), 16);
  callback();
  await idle;
  scheduler.promote();
  const foreground = scheduler.checkpoint();
  await tick();
  expect(timer).toHaveBeenLastCalledWith(expect.any(Function), 0);
  scheduler.dispose();
  await foreground;
  expect(clear).toHaveBeenCalledWith(42);
});

it("starts a bounded initial slice without a task handoff after checking the input gate", async () => {
  const f = fixture();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const finished = vi.fn();
  const initial = f.scheduler.checkpoint(true).then(finished);
  f.scheduler.setBackgroundWait(() => gate);
  await tick();
  expect(finished).not.toHaveBeenCalled();
  expect(f.requestIdle).not.toHaveBeenCalled();
  resume();
  await initial;
  expect(finished).toHaveBeenCalledOnce();
  expect(f.requestIdle).not.toHaveBeenCalled();
  expect(f.post).not.toHaveBeenCalled();
  f.scheduler.setBackgroundWait(undefined);
  const continuation = f.scheduler.checkpoint();
  await tick();
  expect(f.requestIdle).toHaveBeenCalledOnce();
  f.idle();
  await continuation;
  f.scheduler.dispose();
});
