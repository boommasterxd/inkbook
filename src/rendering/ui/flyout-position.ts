interface FlyoutRect {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

export interface FlyoutBoundary {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface FlyoutPositionInput {
  readonly boundary?: FlyoutBoundary;
  readonly boundaryHeight?: number;
  readonly boundaryWidth?: number;
  readonly flyoutHeight: number;
  readonly flyoutWidth: number;
  readonly gap?: number;
  readonly margin?: number;
  readonly trigger: FlyoutRect;
}

export interface FlyoutPosition {
  readonly left: number;
  readonly top: number;
}

export interface FlyoutPositionLifecycle {
  dispose(): void;
  reposition(): void;
}

export function resolveFlyoutPosition(input: FlyoutPositionInput): FlyoutPosition {
  const gap = input.gap ?? 8;
  const margin = input.margin ?? 8;
  const boundary = normalizedBoundary(input);
  const minimumLeft = boundary.left + margin;
  const minimumTop = boundary.top + margin;
  const maximumLeft = Math.max(minimumLeft, boundary.right - input.flyoutWidth - margin);
  const maximumTop = Math.max(minimumTop, boundary.bottom - input.flyoutHeight - margin);
  const below = input.trigger.bottom + gap;
  const above = input.trigger.top - input.flyoutHeight - gap;
  const preferredTop = below + input.flyoutHeight <= boundary.bottom - margin ? below : above;

  return {
    left: clamp(input.trigger.left, minimumLeft, maximumLeft),
    top: clamp(preferredTop, minimumTop, maximumTop),
  };
}

export function positionFlyoutPanel(
  panel: HTMLElement,
  trigger: HTMLElement,
  ownerDocument: Document,
): void {
  const boundary = resolveVisibleOwnerBoundary(trigger, ownerDocument);
  panel.style.maxInlineSize = `${String(Math.max(0, boundary.right - boundary.left - 16))}px`;
  panel.style.maxBlockSize = `${String(Math.max(0, boundary.bottom - boundary.top - 16))}px`;
  const position = resolveFlyoutPosition({
    boundary,
    flyoutHeight: panel.offsetHeight,
    flyoutWidth: panel.offsetWidth,
    trigger: trigger.getBoundingClientRect(),
  });
  panel.style.left = `${String(position.left)}px`;
  panel.style.top = `${String(position.top)}px`;
}

export function createFlyoutPositionLifecycle(
  panel: HTMLElement,
  trigger: HTMLElement,
  ownerDocument: Document,
): FlyoutPositionLifecycle {
  const owningWindow = ownerDocument.defaultView ?? null;
  let active = true;
  let frame: number | undefined;
  const reposition = (): void => {
    if (active) positionFlyoutPanel(panel, trigger, ownerDocument);
  };
  const schedule = (): void => {
    if (!active || frame !== undefined) return;
    if (owningWindow === null) {
      reposition();
      return;
    }
    frame = owningWindow.requestAnimationFrame(() => {
      frame = undefined;
      reposition();
    });
  };
  const observer = createPositionObserver(owningWindow, schedule, panel, trigger);
  ownerDocument.addEventListener("scroll", schedule, true);
  owningWindow?.addEventListener("resize", schedule, { passive: true });
  reposition();
  return {
    dispose: () => {
      if (!active) return;
      active = false;
      if (frame !== undefined) owningWindow?.cancelAnimationFrame(frame);
      frame = undefined;
      observer?.disconnect();
      ownerDocument.removeEventListener("scroll", schedule, true);
      owningWindow?.removeEventListener("resize", schedule);
    },
    reposition: schedule,
  };
}

export function resolveVisibleOwnerBoundary(
  trigger: HTMLElement,
  ownerDocument: Document,
): FlyoutBoundary {
  const viewport = viewportBoundary(ownerDocument);
  const owner = resolveVisibleOwner(trigger, ownerDocument);
  if (owner === null || owner === ownerDocument.scrollingElement) return viewport;
  const rect = owner.getBoundingClientRect();
  const left = rect.left + owner.clientLeft;
  const top = rect.top + owner.clientTop;
  return {
    bottom: Math.max(viewport.top, Math.min(viewport.bottom, top + owner.clientHeight)),
    left: Math.max(viewport.left, Math.min(viewport.right, left)),
    right: Math.max(viewport.left, Math.min(viewport.right, left + owner.clientWidth)),
    top: Math.max(viewport.top, Math.min(viewport.bottom, top)),
  };
}

function resolveVisibleOwner(trigger: HTMLElement, ownerDocument: Document): HTMLElement | null {
  const owningWindow = ownerDocument.defaultView ?? null;
  if (owningWindow === null) return ownerDocument.scrollingElement as HTMLElement | null;
  for (let current = trigger.parentElement; current !== null; current = current.parentElement) {
    const overflow = owningWindow.getComputedStyle(current).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
  }
  return ownerDocument.scrollingElement as HTMLElement | null;
}

function createPositionObserver(
  owningWindow: Window | null,
  schedule: () => void,
  panel: HTMLElement,
  trigger: HTMLElement,
): ResizeObserver | undefined {
  if (owningWindow === null || !hasResizeObserver(owningWindow)) return undefined;
  const observer = new owningWindow.ResizeObserver(schedule);
  observer.observe(panel);
  observer.observe(trigger);
  return observer;
}

function hasResizeObserver(
  owningWindow: Window,
): owningWindow is Window & { readonly ResizeObserver: typeof ResizeObserver } {
  return "ResizeObserver" in owningWindow && typeof owningWindow.ResizeObserver === "function";
}

function viewportBoundary(ownerDocument: Document): FlyoutBoundary {
  return {
    bottom: ownerDocument.documentElement.clientHeight,
    left: 0,
    right: ownerDocument.documentElement.clientWidth,
    top: 0,
  };
}

function normalizedBoundary(input: FlyoutPositionInput): FlyoutBoundary {
  if (input.boundary !== undefined) return input.boundary;
  return {
    bottom: input.boundaryHeight ?? 0,
    left: 0,
    right: input.boundaryWidth ?? 0,
    top: 0,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
