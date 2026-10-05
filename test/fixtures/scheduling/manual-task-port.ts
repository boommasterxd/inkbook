import type { HostTaskChannel, HostTaskPort } from "../../../src/domain/scheduling/host-task-queue";

export class ManualTaskPort implements HostTaskPort {
  public time = 0;
  public channelMode: "available" | "absent" | "construction-failure" | "post-failure" =
    "available";
  public channelAttempts = 0;
  public openPorts = 0;
  public messagePosts = 0;
  public readonly delays: number[] = [];
  readonly #messages: Array<() => void> = [];
  readonly #timers = new Map<number, { callback: () => void; delay: number }>();
  #nextHandle = 0;

  public now = (): number => this.time;
  public openChannel = (receive: () => void): HostTaskChannel | undefined => {
    this.channelAttempts += 1;
    if (this.channelMode === "absent") return undefined;
    if (this.channelMode === "construction-failure") throw new Error("Channel unavailable.");
    this.openPorts += 2;
    let closed = false;
    return {
      post: () => {
        if (this.channelMode === "post-failure") throw new Error("Channel post failed.");
        this.messagePosts += 1;
        this.#messages.push(() => {
          if (!closed) receive();
        });
      },
      close: () => {
        if (closed) throw new Error("Channel already closed.");
        closed = true;
        this.openPorts -= 2;
      },
    };
  };
  public setTimer = (callback: () => void, delay: number): number => {
    const handle = ++this.#nextHandle;
    this.delays.push(delay);
    this.#timers.set(handle, { callback, delay });
    return handle;
  };
  public clearTimer = (handle: number): void => {
    this.#timers.delete(handle);
  };

  public runNextTask(): void {
    const message = this.#messages.shift();
    if (message !== undefined) {
      message();
      return;
    }
    const next = this.#timers.entries().next().value;
    if (next === undefined) throw new Error("No host task is pending.");
    const [handle, { callback }] = next;
    this.#timers.delete(handle);
    callback();
  }

  public get pendingMessages(): number {
    return this.#messages.length;
  }

  public get pendingTimers(): number {
    return this.#timers.size;
  }
}
