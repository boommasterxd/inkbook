import type { FrameSchedulerHost } from "../../../src/domain/scheduling/shared-frame-scheduler";

export class ManualHost implements FrameSchedulerHost {
  public time = 0;
  public budget = 4;
  public frameInterval = 8;
  public hidden = false;
  public frameRequests = 0;
  public timerRequests = 0;
  readonly #frames = new Map<number, (timestamp: number) => void>();
  readonly #timers = new Map<number, { callback: () => void; delayMs: number }>();
  #nextHandle = 0;

  public now = (): number => this.time;
  public budgetMs = (): number => this.budget;
  public frameIntervalMs = (): number => this.frameInterval;
  public isHidden = (): boolean => this.hidden;
  public requestFrame = (callback: (timestamp: number) => void): number => {
    const handle = ++this.#nextHandle;
    this.#frames.set(handle, callback);
    this.frameRequests += 1;
    return handle;
  };
  public cancelFrame = (handle: number): void => {
    this.#frames.delete(handle);
  };
  public setTimer = (callback: () => void, delayMs: number): number => {
    const handle = ++this.#nextHandle;
    this.#timers.set(handle, { callback, delayMs });
    this.timerRequests += 1;
    return handle;
  };
  public clearTimer = (handle: number): void => {
    this.#timers.delete(handle);
  };

  public frame(timestamp = this.time): void {
    const callbacks = [...this.#frames.values()];
    this.#frames.clear();
    for (const callback of callbacks) callback(timestamp);
  }

  public timer(delayMs = 50): void {
    const pending = [...this.#timers].find(([, timer]) => timer.delayMs === delayMs);
    if (pending === undefined) throw new Error(`No ${delayMs} ms timer is pending.`);
    this.#timers.delete(pending[0]);
    pending[1].callback();
  }

  public get pendingFrames(): number {
    return this.#frames.size;
  }

  public get pendingTimers(): number {
    return this.#timers.size;
  }
}
