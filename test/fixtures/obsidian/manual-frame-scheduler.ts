import type { HandleFrameScheduler } from "../../../src/obsidian/embeds/active-editor/handle-interaction";

export class ManualFrameScheduler implements HandleFrameScheduler {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #handle = 0;
  public cancelledFrames = 0;

  public get pendingCount(): number {
    return this.#callbacks.size;
  }

  public cancelAnimationFrame(handle: number): void {
    if (this.#callbacks.delete(handle)) this.cancelledFrames += 1;
  }

  public cancelFrame(handle: number): void {
    this.cancelAnimationFrame(handle);
  }

  public requestAnimationFrame(callback: FrameRequestCallback): number {
    const handle = ++this.#handle;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  public requestFrame(callback: FrameRequestCallback): number {
    return this.requestAnimationFrame(callback);
  }

  public runNext(time = performance.now()): void {
    const next = this.#callbacks.entries().next().value;
    if (next === undefined) throw new Error("No frame is pending.");
    this.#callbacks.delete(next[0]);
    next[1](time);
  }
}
