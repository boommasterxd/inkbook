const NAVIGATION_QUIET_MS = 120;

/** Keeps background preparation paused through navigation frames and their quiet tail. */
export class NavigationActivity {
  #active = false;
  #held = false;
  #timer: number | undefined;

  public constructor(
    private ownerWindow: Window,
    private readonly onActive?: (active: boolean) => void,
  ) {}

  public pulse(): void {
    this.#activate();
    if (!this.#held) this.settle();
  }

  public hold(): void {
    this.#activate();
    this.#held = true;
    this.#clearTimer();
  }

  public settle(): void {
    this.#held = false;
    this.#clearTimer();
    if (!this.#active) return;
    this.#timer = this.ownerWindow.setTimeout(() => {
      this.#timer = undefined;
      this.reset();
    }, NAVIGATION_QUIET_MS);
  }

  public reset(): void {
    this.#clearTimer();
    this.#held = false;
    if (!this.#active) return;
    this.#active = false;
    this.onActive?.(false);
  }

  public transfer(ownerWindow: Window): void {
    this.reset();
    this.ownerWindow = ownerWindow;
  }

  #activate(): void {
    if (this.#active || this.onActive === undefined) return;
    this.#active = true;
    this.onActive(true);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.ownerWindow.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
