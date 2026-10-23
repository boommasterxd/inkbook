export class ActiveSceneTimeout {
  readonly #ownerWindow: Window;
  #pending: { handle: number; readonly resolve: () => void } | undefined;

  public constructor(ownerWindow: Window) {
    this.#ownerWindow = ownerWindow;
  }

  public wait(delay: number): Promise<void> {
    this.cancel();
    return new Promise((resolve) => {
      const pending = { handle: 0, resolve };
      pending.handle = this.#ownerWindow.setTimeout(() => {
        if (this.#pending === pending) this.#pending = undefined;
        resolve();
      }, delay);
      this.#pending = pending;
    });
  }

  public cancel(): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    this.#ownerWindow.clearTimeout(pending.handle);
    pending.resolve();
  }
}
