export class ActiveEditorLongPressScheduler {
  readonly #ownerWindow: Window;
  readonly #timers = new Map<number, number>();

  public constructor(ownerWindow: Window) {
    this.#ownerWindow = ownerWindow;
  }

  public cancel(pointerId: number): void {
    const handle = this.#timers.get(pointerId);
    if (handle !== undefined) this.#ownerWindow.clearTimeout(handle);
    this.#timers.delete(pointerId);
  }

  public dispose(): void {
    for (const pointerId of this.#timers.keys()) this.cancel(pointerId);
  }

  public schedule(pointerId: number, delayMs: number, callback: () => void): void {
    this.cancel(pointerId);
    const handle = this.#ownerWindow.setTimeout(() => {
      this.#timers.delete(pointerId);
      callback();
    }, delayMs);
    this.#timers.set(pointerId, handle);
  }
}
