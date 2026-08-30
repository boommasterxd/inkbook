interface CanvasTouchBoundaryOptions {
  readonly onPrimaryTouchStart: () => void;
  readonly onTouchInterrupted: () => void;
  readonly onTouchPointerMove: (event: PointerEvent) => void;
  readonly onTouchPointerStart: (event: PointerEvent) => void;
  readonly onTouchTerminal: (pointerId: number) => void;
  readonly shouldBlockTouchEvent: () => boolean;
}

/**
 * Keeps canvas-owned touch gestures out of Obsidian's pane and drawer gesture
 * handlers while still allowing terminal events to reach host cleanup code.
 */
export class CanvasTouchBoundary {
  readonly #options: CanvasTouchBoundaryOptions;
  readonly #ownerDocument: Document;
  readonly #ownerWindow: Window;
  readonly #surface: HTMLElement;
  readonly #terminalRecoveries = new Map<number, number>();
  #disposed = false;

  public constructor(surface: HTMLElement, options: CanvasTouchBoundaryOptions) {
    const ownerWindow = surface.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The touch boundary requires an owning window.");
    this.#options = options;
    this.#ownerDocument = surface.ownerDocument;
    this.#ownerWindow = ownerWindow;
    this.#surface = surface;
    surface.addEventListener("pointerdown", this.#handlePointerStart, {
      capture: true,
      passive: false,
    });
    surface.addEventListener("pointermove", this.#handlePointerMove, {
      capture: true,
      passive: false,
    });
    surface.addEventListener("touchstart", this.#handleTouchEvent, {
      capture: true,
      passive: false,
    });
    surface.addEventListener("touchmove", this.#handleTouchEvent, {
      capture: true,
      passive: false,
    });
    ownerWindow.addEventListener("pointerup", this.#handlePointerTerminal, true);
    ownerWindow.addEventListener("pointercancel", this.#handlePointerTerminal, true);
    ownerWindow.addEventListener("blur", this.#handleInterrupted);
    this.#ownerDocument.addEventListener("visibilitychange", this.#handleVisibilityChange);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#surface.removeEventListener("pointerdown", this.#handlePointerStart, true);
    this.#surface.removeEventListener("pointermove", this.#handlePointerMove, true);
    this.#surface.removeEventListener("touchstart", this.#handleTouchEvent, true);
    this.#surface.removeEventListener("touchmove", this.#handleTouchEvent, true);
    this.#ownerWindow.removeEventListener("pointerup", this.#handlePointerTerminal, true);
    this.#ownerWindow.removeEventListener("pointercancel", this.#handlePointerTerminal, true);
    for (const timer of this.#terminalRecoveries.values()) this.#ownerWindow.clearTimeout(timer);
    this.#terminalRecoveries.clear();
    this.#ownerWindow.removeEventListener("blur", this.#handleInterrupted);
    this.#ownerDocument.removeEventListener("visibilitychange", this.#handleVisibilityChange);
  }

  readonly #handlePointerStart = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") return;
    if (event.isPrimary) this.#options.onPrimaryTouchStart();
    this.#options.onTouchPointerStart(event);
    stopHostPropagation(event);
  };

  readonly #handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") return;
    this.#options.onTouchPointerMove(event);
    stopHostPropagation(event);
  };

  readonly #handleTouchEvent = (event: TouchEvent): void => {
    if (!this.#options.shouldBlockTouchEvent()) return;
    if (event.cancelable) event.preventDefault();
    stopHostPropagation(event);
  };

  readonly #handlePointerTerminal = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") return;
    const pointerId = event.pointerId;
    const previous = this.#terminalRecoveries.get(pointerId);
    if (previous !== undefined) this.#ownerWindow.clearTimeout(previous);
    const timer = this.#ownerWindow.setTimeout(() => {
      this.#terminalRecoveries.delete(pointerId);
      if (!this.#disposed) this.#options.onTouchTerminal(pointerId);
    }, 0);
    this.#terminalRecoveries.set(pointerId, timer);
  };

  readonly #handleInterrupted = (): void => this.#options.onTouchInterrupted();

  readonly #handleVisibilityChange = (): void => {
    if (this.#ownerDocument.visibilityState === "hidden") this.#options.onTouchInterrupted();
  };
}

function stopHostPropagation(event: Event): void {
  event.stopPropagation();
}
