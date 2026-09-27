import { SharedFrameScheduler } from "../../domain/scheduling/shared-frame-scheduler";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

interface ScheduledTask {
  readonly callback: () => void;
  timeout: number | undefined;
}

/** Reuses one message channel so short continuations do not incur timer clamping. */
class WindowTaskQueue {
  readonly #tasks = new Map<number, ScheduledTask>();
  readonly #messages = new Set<number>();
  readonly #ownerWindow: Window;
  #channel: MessageChannel | undefined;
  #channelUnavailable = false;
  #posted = false;
  #disposed = false;
  #nextHandle = 0;

  public constructor(ownerWindow: Window) {
    this.#ownerWindow = ownerWindow;
  }

  public schedule(callback: () => void, delayMs: number): number {
    if (this.#disposed) throw new Error("Window task queue disposed.");
    const handle = ++this.#nextHandle;
    this.#tasks.set(handle, { callback, timeout: undefined });
    if (delayMs === 0 && this.#ensureChannel()) {
      this.#messages.add(handle);
      this.#post();
    } else {
      this.#scheduleTimeout(handle, delayMs);
    }
    return handle;
  }

  public cancel(handle: number): void {
    const task = this.#tasks.get(handle);
    if (task === undefined) return;
    this.#tasks.delete(handle);
    this.#messages.delete(handle);
    if (task.timeout !== undefined) this.#ownerWindow.clearTimeout(task.timeout);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const handle of this.#tasks.keys()) this.cancel(handle);
    this.#closeChannel();
  }

  #ensureChannel(): boolean {
    if (this.#channel !== undefined) return true;
    if (this.#channelUnavailable) return false;
    const messageChannelConstructor = (
      this.#ownerWindow as Window & { MessageChannel?: typeof MessageChannel }
    ).MessageChannel;
    if (messageChannelConstructor === undefined) {
      this.#channelUnavailable = true;
      return false;
    }
    try {
      this.#channel = new messageChannelConstructor();
      this.#channel.port1.onmessage = () => this.#runMessage();
      return true;
    } catch {
      this.#channelUnavailable = true;
      return false;
    }
  }

  #post(): void {
    if (this.#posted || this.#messages.size === 0 || this.#channel === undefined) return;
    this.#posted = true;
    try {
      this.#channel.port2.postMessage(null);
    } catch {
      this.#posted = false;
      this.#channelUnavailable = true;
      this.#closeChannel();
      for (const handle of this.#messages) this.#scheduleTimeout(handle, 0);
      this.#messages.clear();
    }
  }

  #runMessage(): void {
    this.#posted = false;
    if (this.#disposed) return;
    const handle = this.#messages.values().next().value;
    if (handle === undefined) return;
    this.#messages.delete(handle);
    const task = this.#tasks.get(handle);
    if (task === undefined) return;
    this.#tasks.delete(handle);
    try {
      task.callback();
    } finally {
      this.#post();
    }
  }

  #scheduleTimeout(handle: number, delayMs: number): void {
    const task = this.#tasks.get(handle);
    if (task === undefined) return;
    task.timeout = this.#ownerWindow.setTimeout(() => {
      this.#tasks.delete(handle);
      task.callback();
    }, delayMs);
  }

  #closeChannel(): void {
    this.#channel?.port1.close();
    this.#channel?.port2.close();
    this.#channel = undefined;
    this.#posted = false;
  }
}

/** The sole native frame adapter for cooperative work in an Obsidian window. */
export function createWindowWorkScheduler(
  ownerWindow: Window,
  profile: () => { readonly sliceBudgetMs: number; readonly frameDurationMs: number },
): WorkScheduler {
  const tasks = new WindowTaskQueue(ownerWindow);
  return new SharedFrameScheduler({
    now: () => ownerWindow.performance.now(),
    budgetMs: () => profile().sliceBudgetMs,
    frameIntervalMs: () => profile().frameDurationMs,
    requestFrame: (callback) => ownerWindow.requestAnimationFrame(callback),
    cancelFrame: (handle) => ownerWindow.cancelAnimationFrame(handle),
    setTimer: (callback, delay) => tasks.schedule(callback, delay),
    clearTimer: (handle) => tasks.cancel(handle),
    isHidden: () => ownerWindow.document.visibilityState === "hidden",
    dispose: () => tasks.dispose(),
  });
}
