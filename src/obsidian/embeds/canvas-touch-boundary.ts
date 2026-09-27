interface CanvasTouchBoundaryOptions {
  readonly onPenPointerCancel: (event: PointerEvent) => void;
  readonly onPenPointerMove: (event: PointerEvent) => void;
  readonly onPenPointerStart: (event: PointerEvent) => void;
  readonly onPenPointerUp: (event: PointerEvent) => void;
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
  readonly #activePenPointers = new Set<number>();
  readonly #terminalRecoveries = new Map<number, number>();
  #disposed = false;
  #penHovering = false;
  #penInputPresent = false;

  public constructor(surface: HTMLElement, options: CanvasTouchBoundaryOptions) {
    const ownerWindow = surface.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The touch boundary requires an owning window.");
    this.#options = options;
    this.#ownerDocument = surface.ownerDocument;
    this.#ownerWindow = ownerWindow;
    this.#surface = surface;
    ownerWindow.addEventListener("pointerdown", this.#handlePointerStart, {
      capture: true,
      passive: false,
    });
    ownerWindow.addEventListener("pointermove", this.#handlePointerMove, {
      capture: true,
      passive: false,
    });
    ownerWindow.addEventListener("pointerup", this.#handlePointerUp, {
      capture: true,
      passive: false,
    });
    ownerWindow.addEventListener("pointercancel", this.#handlePointerCancel, {
      capture: true,
      passive: false,
    });
    ownerWindow.addEventListener("pointerover", this.#handlePointerOver, true);
    ownerWindow.addEventListener("pointerout", this.#handlePointerOut, true);
    ownerWindow.addEventListener("touchstart", this.#handleTouchEvent, {
      capture: true,
      passive: false,
    });
    ownerWindow.addEventListener("touchmove", this.#handleTouchEvent, {
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
    this.#ownerWindow.removeEventListener("pointerdown", this.#handlePointerStart, true);
    this.#ownerWindow.removeEventListener("pointermove", this.#handlePointerMove, true);
    this.#ownerWindow.removeEventListener("pointerup", this.#handlePointerUp, true);
    this.#ownerWindow.removeEventListener("pointercancel", this.#handlePointerCancel, true);
    this.#ownerWindow.removeEventListener("pointerover", this.#handlePointerOver, true);
    this.#ownerWindow.removeEventListener("pointerout", this.#handlePointerOut, true);
    this.#ownerWindow.removeEventListener("touchstart", this.#handleTouchEvent, true);
    this.#ownerWindow.removeEventListener("touchmove", this.#handleTouchEvent, true);
    this.#ownerWindow.removeEventListener("pointerup", this.#handlePointerTerminal, true);
    this.#ownerWindow.removeEventListener("pointercancel", this.#handlePointerTerminal, true);
    for (const timer of this.#terminalRecoveries.values()) this.#ownerWindow.clearTimeout(timer);
    this.#terminalRecoveries.clear();
    this.#activePenPointers.clear();
    this.#penHovering = false;
    this.#syncPenInputPresence();
    this.#ownerWindow.removeEventListener("blur", this.#handleInterrupted);
    this.#ownerDocument.removeEventListener("visibilitychange", this.#handleVisibilityChange);
  }

  readonly #handlePointerStart = (event: PointerEvent): void => {
    if (!this.#isSurfaceEvent(event)) return;
    if (event.pointerType === "pen") {
      this.#activePenPointers.add(event.pointerId);
      this.#syncPenInputPresence();
      blockPenPointerEvent(event);
      this.#options.onPenPointerStart(event);
      return;
    }
    if (event.pointerType !== "touch") return;
    this.#releaseStalePenHover(event);
    if (event.isPrimary) this.#options.onPrimaryTouchStart();
    this.#options.onTouchPointerStart(event);
    stopHostPropagation(event);
  };

  readonly #handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "pen") {
      if (!this.#isSurfaceEvent(event) && !this.#activePenPointers.has(event.pointerId)) return;
      blockPenPointerEvent(event);
      this.#options.onPenPointerMove(event);
      return;
    }
    if (!this.#isSurfaceEvent(event)) return;
    if (event.pointerType !== "touch") return;
    this.#options.onTouchPointerMove(event);
    stopHostPropagation(event);
  };

  readonly #handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerType !== "pen") return;
    if (!this.#isSurfaceEvent(event) && !this.#activePenPointers.has(event.pointerId)) return;
    blockPenPointerEvent(event);
    this.#options.onPenPointerUp(event);
    this.#activePenPointers.delete(event.pointerId);
    this.#penHovering = false;
    this.#syncPenInputPresence();
  };

  readonly #handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerType !== "pen") return;
    if (!this.#isSurfaceEvent(event) && !this.#activePenPointers.has(event.pointerId)) return;
    blockPenPointerEvent(event);
    this.#options.onPenPointerCancel(event);
    this.#activePenPointers.delete(event.pointerId);
    this.#penHovering = false;
    this.#syncPenInputPresence();
  };

  readonly #handleTouchEvent = (event: TouchEvent): void => {
    if (!this.#isSurfaceEvent(event)) return;
    if (!this.#penInputPresent && !this.#options.shouldBlockTouchEvent()) return;
    if (event.cancelable) event.preventDefault();
    stopHostPropagation(event);
  };

  readonly #handlePointerOver = (event: PointerEvent): void => {
    if (!this.#isSurfaceEvent(event)) return;
    this.#releaseStalePenHover(event);
    if (event.pointerType !== "pen") return;
    this.#penHovering = true;
    this.#syncPenInputPresence();
  };

  readonly #handlePointerOut = (event: PointerEvent): void => {
    if (event.pointerType !== "pen" || !this.#isSurfaceEvent(event)) return;
    if (this.#contains(event.relatedTarget)) return;
    this.#penHovering = false;
    this.#syncPenInputPresence();
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

  readonly #handleInterrupted = (): void => {
    this.#clearPenInputPresence();
    this.#options.onTouchInterrupted();
  };

  readonly #handleVisibilityChange = (): void => {
    if (this.#ownerDocument.visibilityState !== "hidden") return;
    this.#clearPenInputPresence();
    this.#options.onTouchInterrupted();
  };

  #releaseStalePenHover(event: PointerEvent): void {
    if (event.pointerType !== "touch" || !event.isPrimary || this.#activePenPointers.size > 0)
      return;
    // Some pen drivers omit pointerout when switching directly from pen to touch.
    this.#penHovering = false;
    this.#syncPenInputPresence();
  }

  #clearPenInputPresence(): void {
    this.#activePenPointers.clear();
    this.#penHovering = false;
    this.#syncPenInputPresence();
  }

  #contains(target: EventTarget | null): boolean {
    return (
      target !== null &&
      target !== undefined &&
      "nodeType" in target &&
      this.#surface.contains(target as Node)
    );
  }

  #isSurfaceEvent(event: Event): boolean {
    return this.#contains(event.target);
  }

  #syncPenInputPresence(): void {
    const present = this.#penHovering || this.#activePenPointers.size > 0;
    if (present === this.#penInputPresent) return;
    this.#penInputPresent = present;
    this.#surface.toggleAttribute("data-inkbook-pen-input", present);
  }
}

function stopHostPropagation(event: Event): void {
  event.stopImmediatePropagation();
  event.stopPropagation();
}

function blockPenPointerEvent(event: PointerEvent): void {
  if (event.cancelable) event.preventDefault();
  stopHostPropagation(event);
}
