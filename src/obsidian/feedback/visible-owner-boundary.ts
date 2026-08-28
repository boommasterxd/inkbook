export interface VisibleOwnerBoundary {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export function resolveVisibleOwnerBoundary(
  trigger: HTMLElement,
  ownerDocument: Document,
): VisibleOwnerBoundary {
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

function viewportBoundary(ownerDocument: Document): VisibleOwnerBoundary {
  return {
    bottom: ownerDocument.documentElement.clientHeight,
    left: 0,
    right: ownerDocument.documentElement.clientWidth,
    top: 0,
  };
}
