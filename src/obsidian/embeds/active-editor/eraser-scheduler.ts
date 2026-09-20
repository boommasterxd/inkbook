import type { EraserSliceScheduler } from "../../../editor/gestures/public";

export class EraserFrameScheduler implements EraserSliceScheduler {
  readonly #ownerWindow: Window;
  readonly #isStale: () => boolean;
  #cancelled = false;
  #deadline: number;
  #pending: { readonly frame: number; readonly resolve: () => void } | null = null;
  readonly #sliceBudgetMs: () => number;

  public constructor(
    ownerWindow: Window,
    sliceBudgetMs: () => number,
    isStale: () => boolean = () => false,
  ) {
    this.#isStale = isStale;
    this.#ownerWindow = ownerWindow;
    this.#sliceBudgetMs = sliceBudgetMs;
    this.#deadline = ownerWindow.performance.now() + sliceBudgetMs();
  }

  public isCancelled(): boolean {
    return this.#cancelled || this.#isStale();
  }

  public shouldYield(): boolean {
    return this.#ownerWindow.performance.now() >= this.#deadline;
  }

  public yieldControl(): Promise<void> {
    if (this.#cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      const frame = this.#ownerWindow.requestAnimationFrame(() => {
        this.#pending = null;
        this.#deadline = this.#ownerWindow.performance.now() + this.#sliceBudgetMs();
        resolve();
      });
      this.#pending = { frame, resolve };
    });
  }

  public cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#ownerWindow.cancelAnimationFrame(pending.frame);
    pending.resolve();
  }
}
