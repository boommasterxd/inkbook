/** Host adapters own native channels and expose only portable task operations. */
export interface HostTaskChannel {
  /** Deliver the registered receiver on a later host task, after current microtasks. */
  post(): void;
  close(): void;
}

/** Owns portable channel subscriptions and port cleanup without inspecting host events. */
export function createHostTaskChannel<Event>(
  receiver: { onmessage: ((event: Event) => void) | null; close(): void },
  sender: { postMessage(value: null): void; close(): void },
  receive: () => void,
): HostTaskChannel {
  receiver.onmessage = receive;
  return {
    post: () => sender.postMessage(null),
    close: () => {
      receiver.onmessage = null;
      receiver.close();
      sender.close();
    },
  };
}

export interface HostTaskPort {
  openChannel?(receive: () => void): HostTaskChannel | undefined;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
}

interface ScheduledTask {
  readonly callback: () => void;
  timeout: number | undefined;
}

/** Dispatches one callback per host task without owning work admission policy. */
export class HostTaskQueue {
  readonly #tasks = new Map<number, ScheduledTask>();
  readonly #messages = new Set<number>();
  readonly #host: HostTaskPort;
  #channel: HostTaskChannel | undefined;
  #channelUnavailable = false;
  #posted = false;
  #disposed = false;
  #nextHandle = 0;

  public constructor(host: HostTaskPort) {
    this.#host = host;
  }

  public schedule(callback: () => void, delayMs: number): number {
    if (this.#disposed) throw new Error("Host task queue disposed.");
    const handle = ++this.#nextHandle;
    this.#tasks.set(handle, { callback, timeout: undefined });
    if (delayMs === 0 && this.#ensureChannel()) {
      this.#messages.add(handle);
      this.#post();
    } else {
      this.#scheduleTimer(handle, delayMs);
    }
    return handle;
  }

  public cancel(handle: number): void {
    const task = this.#tasks.get(handle);
    if (task === undefined) return;
    this.#tasks.delete(handle);
    this.#messages.delete(handle);
    if (task.timeout !== undefined) this.#host.clearTimer(task.timeout);
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
    try {
      this.#channel = this.#host.openChannel?.(() => this.#runMessage());
    } catch {
      this.#channelUnavailable = true;
      return false;
    }
    this.#channelUnavailable = this.#channel === undefined;
    return !this.#channelUnavailable;
  }

  #post(): void {
    if (this.#posted || this.#messages.size === 0 || this.#channel === undefined) return;
    this.#posted = true;
    try {
      this.#channel.post();
    } catch {
      this.#channelUnavailable = true;
      this.#closeChannel();
      for (const handle of this.#messages) this.#scheduleTimer(handle, 0);
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

  #scheduleTimer(handle: number, delayMs: number): void {
    const task = this.#tasks.get(handle);
    if (task === undefined) return;
    task.timeout = this.#host.setTimer(() => {
      if (!this.#tasks.delete(handle)) return;
      task.callback();
    }, delayMs);
  }

  #closeChannel(): void {
    this.#channel?.close();
    this.#channel = undefined;
    this.#posted = false;
  }
}
