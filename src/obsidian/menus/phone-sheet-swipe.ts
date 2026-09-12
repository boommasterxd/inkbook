const DIRECTION_THRESHOLD_PX = 6;
const DISMISS_DISTANCE_RATIO = 0.5;
const DISMISS_VELOCITY_PX_PER_MS = 0.45;

interface PhoneSheetSwipeOptions {
  readonly backdrop: HTMLElement;
  readonly close: () => void;
  readonly durationMs: number;
  readonly ownerWindow: Window;
  readonly scroll: HTMLElement;
  readonly surface: HTMLElement;
}

interface SwipeGesture {
  distance: number;
  dragging: boolean;
  height: number;
  offset: number;
  readonly pointerId: number;
  readonly startTime: number;
  readonly startX: number;
  readonly startY: number;
  readonly target: Element;
}

export class PhoneSheetSwipeController {
  #clickTimer: number | undefined;
  #clickTarget: Element | undefined;
  #dragFrame: number | undefined;
  #gesture: SwipeGesture | undefined;
  #pendingDragDistance: number | undefined;
  #pendingDragHeight: number | undefined;
  readonly #options: PhoneSheetSwipeOptions;
  #resetFrame: number | undefined;
  #resetTimer: number | undefined;
  #suppressClick = false;

  public constructor(options: PhoneSheetSwipeOptions) {
    this.#options = options;
    this.syncScrollPosition();
  }

  public dispose(): void {
    this.prepareClose();
    this.#clearClickSuppression();
    this.#resetPresentation();
    delete this.#options.surface.dataset.scrollPosition;
  }

  public handleClick = (event: Event): void => {
    if (!this.#suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.#clearClickSuppression();
  };

  public handleLostPointerCapture = (event: PointerEvent): void => {
    this.#interruptGesture(event);
  };

  public handlePointerCancel = (event: PointerEvent): void => {
    this.#interruptGesture(event);
  };

  #interruptGesture(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (gesture?.pointerId !== event.pointerId) return;
    this.#gesture = undefined;
    if (gesture.dragging) this.#settle();
  }

  public handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" || this.#gesture !== undefined) return;
    const target = event.target;
    if (!isElement(target)) return;
    const fromHandle = target.closest(".inkbook-adaptive-panel-drag-region") !== null;
    if (!fromHandle && this.#options.scroll.scrollTop > 0) return;
    this.#gesture = {
      distance: 0,
      dragging: false,
      height: 0,
      offset: 0,
      pointerId: event.pointerId,
      startTime: event.timeStamp,
      startX: event.clientX,
      startY: event.clientY,
      target,
    };
    if (fromHandle) this.#beginDrag(event);
  };

  public handlePointerMove = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (gesture?.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.dragging && !this.#claimDownwardGesture(event, deltaX, deltaY)) return;
    event.preventDefault();
    gesture.distance = Math.max(0, gesture.offset + deltaY);
    this.#renderDrag(gesture.distance, gesture.height);
  };

  public handlePointerUp = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (gesture?.pointerId !== event.pointerId) return;
    this.#gesture = undefined;
    if (!gesture.dragging) return;
    event.preventDefault();
    this.#suppressFollowingClick(gesture.target);
    const distance = Math.max(0, gesture.offset + event.clientY - gesture.startY);
    this.#renderDrag(distance, gesture.height);
    this.#flushPendingDrag();
    const elapsed = Math.max(1, event.timeStamp - gesture.startTime);
    const height = gesture.height;
    const threshold = height > 0 ? height * DISMISS_DISTANCE_RATIO : Infinity;
    if (
      distance >= threshold ||
      Math.max(0, distance - gesture.offset) / elapsed >= DISMISS_VELOCITY_PX_PER_MS
    ) {
      this.#options.close();
      return;
    }
    this.#settle();
  };

  public prepareClose(): void {
    this.#gesture = undefined;
    this.#cancelResetWork();
    this.#flushPendingDrag();
    this.#captureExitPosition();
    delete this.#options.surface.dataset.swipeState;
    delete this.#options.backdrop.dataset.swipeState;
  }

  public syncScrollPosition = (): void => {
    const position = this.#options.scroll.scrollTop > 0 ? "away" : "top";
    if (this.#options.surface.dataset.scrollPosition !== position) {
      this.#options.surface.dataset.scrollPosition = position;
    }
  };

  #beginDrag(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (gesture === undefined || gesture.dragging) return;
    gesture.dragging = true;
    gesture.height = this.#options.surface.getBoundingClientRect().height;
    const surface = this.#options.surface;
    const interrupted =
      surface.dataset.swipeState === "settling" || surface.dataset.presence === "entering";
    if (interrupted) gesture.offset = this.#visibleDistance(gesture.height);
    this.#cancelResetWork();
    this.#cancelDragFrame();
    this.#options.surface.dataset.swipeState = "dragging";
    this.#options.backdrop.dataset.swipeState = "dragging";
    delete surface.dataset.presence;
    this.#clearExitPosition();
    if (interrupted) this.#applyDrag(gesture.offset, gesture.height);
    event.preventDefault();
  }

  #visibleDistance(height: number): number {
    const translate = this.#options.ownerWindow.getComputedStyle(this.#options.surface).translate;
    const vertical = translate.trim().split(/\s+/)[1] ?? "0";
    const value = Number.parseFloat(vertical);
    return Number.isFinite(value)
      ? Math.max(0, vertical.endsWith("%") ? (height * value) / 100 : value)
      : 0;
  }

  #claimDownwardGesture(event: PointerEvent, deltaX: number, deltaY: number): boolean {
    if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < DIRECTION_THRESHOLD_PX) return false;
    if (deltaY <= 0 || Math.abs(deltaY) <= Math.abs(deltaX)) {
      this.#gesture = undefined;
      return false;
    }
    this.#beginDrag(event);
    return true;
  }

  #clearClickSuppression(): void {
    this.#suppressClick = false;
    this.#clickTarget?.removeEventListener("click", this.handleClick, true);
    this.#clickTarget = undefined;
    if (this.#clickTimer === undefined) return;
    this.#options.ownerWindow.clearTimeout(this.#clickTimer);
    this.#clickTimer = undefined;
  }

  #renderDrag(distance: number, height: number): void {
    this.#pendingDragDistance = distance;
    this.#pendingDragHeight = height;
    if (this.#dragFrame !== undefined) return;
    this.#dragFrame = this.#options.ownerWindow.requestAnimationFrame(() => {
      this.#dragFrame = undefined;
      const pendingDistance = this.#pendingDragDistance;
      const pendingHeight = this.#pendingDragHeight;
      this.#pendingDragDistance = undefined;
      this.#pendingDragHeight = undefined;
      if (pendingDistance === undefined || pendingHeight === undefined) return;
      this.#applyDrag(pendingDistance, pendingHeight);
    });
  }

  #applyDrag(distance: number, height: number): void {
    this.#options.surface.style.setProperty("translate", `0 ${String(distance)}px`);
    const effectiveHeight = Math.max(1, height);
    this.#options.backdrop.style.setProperty(
      "opacity",
      String(1 - Math.min(1, distance / effectiveHeight)),
    );
  }

  #settle(): void {
    if (this.#options.durationMs === 0) {
      this.#resetPresentation();
      return;
    }
    this.#flushPendingDrag();
    this.#options.surface.dataset.swipeState = "settling";
    this.#options.backdrop.dataset.swipeState = "settling";
    this.#resetFrame = this.#options.ownerWindow.requestAnimationFrame(() => {
      this.#resetFrame = undefined;
      this.#options.surface.style.removeProperty("translate");
      this.#options.backdrop.style.removeProperty("opacity");
      this.#resetTimer = this.#options.ownerWindow.setTimeout(
        () => this.#resetPresentation(),
        this.#options.durationMs,
      );
    });
  }

  #suppressFollowingClick(target: Element): void {
    this.#clearClickSuppression();
    this.#suppressClick = true;
    this.#clickTarget = target;
    target.addEventListener("click", this.handleClick, true);
    this.#clickTimer = this.#options.ownerWindow.setTimeout(() => {
      this.#clickTimer = undefined;
      this.#clearClickSuppression();
    }, 0);
  }

  #cancelResetWork(): void {
    if (this.#resetFrame !== undefined) {
      this.#options.ownerWindow.cancelAnimationFrame(this.#resetFrame);
      this.#resetFrame = undefined;
    }
    if (this.#resetTimer !== undefined) {
      this.#options.ownerWindow.clearTimeout(this.#resetTimer);
      this.#resetTimer = undefined;
    }
  }

  #cancelDragFrame(): void {
    if (this.#dragFrame !== undefined) {
      this.#options.ownerWindow.cancelAnimationFrame(this.#dragFrame);
      this.#dragFrame = undefined;
    }
    this.#pendingDragDistance = undefined;
    this.#pendingDragHeight = undefined;
  }

  #flushPendingDrag(): void {
    if (this.#dragFrame !== undefined) {
      this.#options.ownerWindow.cancelAnimationFrame(this.#dragFrame);
      this.#dragFrame = undefined;
    }
    const distance = this.#pendingDragDistance;
    const height = this.#pendingDragHeight;
    this.#pendingDragDistance = undefined;
    this.#pendingDragHeight = undefined;
    if (distance !== undefined && height !== undefined) this.#applyDrag(distance, height);
  }

  #resetPresentation(): void {
    this.#cancelResetWork();
    this.#cancelDragFrame();
    delete this.#options.surface.dataset.swipeState;
    delete this.#options.backdrop.dataset.swipeState;
    this.#options.surface.style.removeProperty("translate");
    this.#options.backdrop.style.removeProperty("opacity");
    this.#clearExitPosition();
  }

  #captureExitPosition(): void {
    const { surface, backdrop, ownerWindow } = this.#options;
    const settling = surface.dataset.swipeState === "settling";
    const translate = settling
      ? ownerWindow.getComputedStyle(surface).translate
      : surface.style.translate;
    const opacity = settling
      ? ownerWindow.getComputedStyle(backdrop).opacity
      : backdrop.style.opacity;
    if (translate)
      surface.style.setProperty(
        "--inkbook-adaptive-panel-drag",
        translate.trim().split(/\s+/)[1] ?? "0px",
      );
    if (opacity) backdrop.style.setProperty("--inkbook-adaptive-panel-backdrop-opacity", opacity);
    surface.style.removeProperty("translate");
    backdrop.style.removeProperty("opacity");
  }

  #clearExitPosition(): void {
    this.#options.surface.style.removeProperty("--inkbook-adaptive-panel-drag");
    this.#options.backdrop.style.removeProperty("--inkbook-adaptive-panel-backdrop-opacity");
  }
}

function isElement(target: EventTarget | null): target is Element {
  return target !== null && "closest" in target;
}
