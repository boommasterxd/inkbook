import { resolveVisibleOwnerBoundary, type VisibleOwnerBoundary } from "./visible-owner-boundary";

interface FeedbackRect {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface PresentationFeedbackPosition {
  readonly bottom: number;
  readonly left: number;
  readonly maxInlineSize: number;
  readonly visible: boolean;
}

export interface PresentationFeedbackPositionLifecycle {
  dispose(): void;
}

export type PresentationFeedbackVerticalAnchor = "bottom" | "center";

export function resolvePresentationFeedbackPosition(
  presentation: FeedbackRect,
  boundary: VisibleOwnerBoundary,
): PresentationFeedbackPosition {
  const left = Math.max(presentation.left, boundary.left);
  const right = Math.min(presentation.right, boundary.right);
  const top = Math.max(presentation.top, boundary.top);
  const bottom = Math.min(presentation.bottom, boundary.bottom);
  const visibleWidth = Math.max(0, right - left);
  const visibleHeight = Math.max(0, bottom - top);
  return {
    bottom: Math.max(0, presentation.bottom - bottom + Math.min(16, visibleHeight / 2)),
    left: left + visibleWidth / 2 - presentation.left,
    maxInlineSize: Math.max(0, visibleWidth - 24),
    visible: visibleWidth > 0 && visibleHeight > 0,
  };
}

export function createPresentationFeedbackPositionLifecycle(
  surface: HTMLElement,
  presentation: HTMLElement,
  verticalAnchor: PresentationFeedbackVerticalAnchor = "bottom",
): PresentationFeedbackPositionLifecycle {
  const ownerDocument = presentation.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) return { dispose: () => undefined };
  let active = true;
  let measured = false;
  let frame: number | undefined;
  const reposition = (): void => {
    if (!active) return;
    if (!measured && verticalAnchor === "center" && !presentation.isConnected) {
      prepareUnmeasuredCenter(surface);
      return;
    }
    measured = true;
    surface.classList.remove("inkbook-feedback-unmeasured");
    const presentationBounds = presentation.getBoundingClientRect();
    const boundary = resolveVisibleOwnerBoundary(presentation, ownerDocument);
    const position = resolvePresentationFeedbackPosition(presentationBounds, boundary);
    applyPosition(surface, position, presentationBounds, boundary, verticalAnchor);
  };
  const schedule = (): void => {
    if (!active || frame !== undefined) return;
    frame = ownerWindow.requestAnimationFrame(() => {
      frame = undefined;
      reposition();
    });
  };
  const observer = createResizeObserver(ownerWindow, schedule, surface, presentation);
  ownerDocument.addEventListener("scroll", schedule, true);
  ownerWindow.addEventListener("resize", schedule, { passive: true });
  reposition();
  if (!presentation.isConnected) schedule();
  return {
    dispose: () => {
      if (!active) return;
      active = false;
      if (frame !== undefined) ownerWindow.cancelAnimationFrame(frame);
      observer?.disconnect();
      ownerDocument.removeEventListener("scroll", schedule, true);
      ownerWindow.removeEventListener("resize", schedule);
    },
  };
}

/** A widget can be created detached and inserted before the next paint. */
function prepareUnmeasuredCenter(surface: HTMLElement): void {
  surface.classList.add("inkbook-feedback-unmeasured");
}

function applyPosition(
  surface: HTMLElement,
  position: PresentationFeedbackPosition,
  presentation: FeedbackRect,
  boundary: VisibleOwnerBoundary,
  verticalAnchor: PresentationFeedbackVerticalAnchor,
): void {
  if (verticalAnchor === "center") {
    const visibleTop = Math.max(presentation.top, boundary.top);
    const visibleBottom = Math.min(presentation.bottom, boundary.bottom);
    surface.style.removeProperty("inset-block-end");
    surface.style.insetBlockStart = `${String(visibleTop + (visibleBottom - visibleTop) / 2 - presentation.top)}px`;
  } else {
    surface.style.insetBlockEnd = `${String(position.bottom)}px`;
    surface.style.removeProperty("inset-block-start");
  }
  surface.style.insetInlineStart = `${String(position.left)}px`;
  surface.style.maxInlineSize = `${String(position.maxInlineSize)}px`;
  surface.style.visibility = position.visible ? "visible" : "hidden";
}

function createResizeObserver(
  ownerWindow: Window,
  schedule: () => void,
  surface: HTMLElement,
  presentation: HTMLElement,
): ResizeObserver | undefined {
  if (!hasResizeObserver(ownerWindow)) return undefined;
  const observer = new ownerWindow.ResizeObserver(schedule);
  observer.observe(surface);
  observer.observe(presentation);
  return observer;
}

function hasResizeObserver(
  ownerWindow: Window,
): ownerWindow is Window & { readonly ResizeObserver: typeof ResizeObserver } {
  return "ResizeObserver" in ownerWindow && typeof ownerWindow.ResizeObserver === "function";
}
