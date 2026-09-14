interface AdaptivePanelHeightOptions {
  readonly scroll: HTMLElement;
  readonly surface: HTMLElement;
  readonly ownerWindow: Window;
  readonly maximumHeight: () => number;
  readonly durationMs: number;
  readonly pageDurationMs: number;
}

/** Owns the single height transition shared by content changes, navigation, and swipe. */
export class AdaptivePanelHeight {
  readonly #options: AdaptivePanelHeightOptions;
  #timer: number | undefined;
  #paused = false;
  #closed = false;

  public constructor(options: AdaptivePanelHeightOptions) {
    this.#options = options;
  }

  public get pageTransitioning(): boolean {
    return this.#options.surface.dataset.pageTransition !== undefined;
  }

  public get paused(): boolean {
    return this.#paused;
  }

  public animate(start: number, direction?: "forward" | "back"): void {
    if (this.#closed) return;
    const { scroll, surface, durationMs, pageDurationMs, maximumHeight, ownerWindow } =
      this.#options;
    surface.dataset.pageMeasuring = "true";
    this.#reset();
    const target = Math.min(scroll.scrollHeight, maximumHeight());
    const resize = durationMs > 0 && start > 0 && target > 0 && Math.abs(start - target) >= 1;
    const pageDuration = direction === undefined ? 0 : pageDurationMs;
    if (pageDuration > 0) {
      surface.dataset.pageTransition = direction;
      surface.style.setProperty("--inkbook-phone-page-duration", `${String(pageDuration)}ms`);
    }
    if (resize) {
      surface.dataset.pageFrozen = "true";
      scroll.style.setProperty("block-size", `${String(start)}px`);
      scroll.getBoundingClientRect();
      delete surface.dataset.pageMeasuring;
      scroll.style.setProperty("block-size", `${String(target)}px`);
    }
    delete surface.dataset.pageMeasuring;
    if (resize || pageDuration > 0) {
      this.#timer = ownerWindow.setTimeout(
        () => this.#reset(),
        Math.max(resize ? durationMs : 0, pageDuration),
      );
    }
  }

  public pause(): void {
    const { scroll, surface } = this.#options;
    if (this.#closed || this.#timer === undefined || !scroll.style.blockSize) return;
    const height = scroll.getBoundingClientRect().height;
    surface.dataset.pageMeasuring = "true";
    this.#reset();
    surface.dataset.pageFrozen = "true";
    scroll.style.setProperty("block-size", `${String(height)}px`);
    scroll.getBoundingClientRect();
    delete surface.dataset.pageMeasuring;
    this.#paused = true;
  }

  public resume(): void {
    if (!this.#closed && this.#paused) {
      this.animate(this.#options.scroll.getBoundingClientRect().height);
    }
  }

  public dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    const { scroll, surface } = this.#options;
    const height =
      this.#timer !== undefined || this.#paused ? scroll.getBoundingClientRect().height : 0;
    this.#reset();
    if (height > 0) {
      surface.dataset.pageFrozen = "true";
      scroll.style.setProperty("block-size", `${String(height)}px`);
    }
  }

  #reset(): void {
    const { scroll, surface, ownerWindow } = this.#options;
    if (this.#timer !== undefined) ownerWindow.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#paused = false;
    delete surface.dataset.pageFrozen;
    delete surface.dataset.pageTransition;
    scroll.style.removeProperty("block-size");
  }
}
