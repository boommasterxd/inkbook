import { MarkdownRenderChild } from "obsidian";

import type { InputHit } from "../../../input/phase-zero";
import type { Disposable } from "./contracts";
import type { ReadingSectionReport } from "./reading-section-coordinator";

const ELEMENT_NODE = 1;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const INITIAL_MARKER_X = 48;
const INITIAL_MARKER_Y = 48;
const MARKER_RADIUS = 18;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const WHEEL_LINE_PIXELS = 16;
const WHEEL_PAGE_FALLBACK_PIXELS = 800;
const MAX_WHEEL_DELTA_PIXELS = 120;

export interface PhaseZeroOverlayNodes {
  readonly marker: SVGCircleElement;
  readonly root: HTMLDivElement;
  readonly svg: SVGSVGElement;
}

export function createPhaseZeroOverlay(
  document: Document,
  surface: string,
): PhaseZeroOverlayNodes {
  const root = document.createElement("div");
  root.className = "inkbook-phase-zero-overlay";
  root.dataset.inkbookSurface = surface;
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("aria-label", "Inkbook Phase 0 annotation layer");
  svg.setAttribute("role", "img");
  svg.style.transformOrigin = `${String(INITIAL_MARKER_X)}px ${String(INITIAL_MARKER_Y)}px`;
  const marker = document.createElementNS(SVG_NAMESPACE, "circle");
  marker.classList.add("inkbook-phase-zero-marker");
  marker.dataset.inkbookElementId = "phase-zero-annotation";
  marker.setAttribute("cx", String(INITIAL_MARKER_X));
  marker.setAttribute("cy", String(INITIAL_MARKER_Y));
  marker.setAttribute("r", String(MARKER_RADIUS));
  marker.setAttribute("tabindex", "0");
  marker.setAttribute("aria-label", "Phase 0 annotation probe");
  svg.append(marker);
  root.append(svg);
  return { marker, root, svg };
}

export interface PhaseZeroEventHandlers {
  readonly contextmenu: (event: MouseEvent) => void;
  readonly keydown: (event: KeyboardEvent) => void;
  readonly lostpointercapture: (event: PointerEvent) => void;
  readonly pointercancel: (event: PointerEvent) => void;
  readonly pointerdown: (event: PointerEvent) => void;
  readonly pointermove: (event: PointerEvent) => void;
  readonly pointerup: (event: PointerEvent) => void;
  readonly touchcancel: (event: TouchEvent) => void;
  readonly touchend: (event: TouchEvent) => void;
  readonly touchmove: (event: TouchEvent) => void;
  readonly touchstart: (event: TouchEvent) => void;
  readonly wheel: (event: WheelEvent) => void;
}

export class PhaseZeroListenerOwner implements Disposable {
  #disposed = false;
  #touchMoveActive = false;

  public constructor(
    private readonly element: HTMLElement,
    private readonly handlers: PhaseZeroEventHandlers,
  ) {
    try {
      this.#add();
    } catch (error: unknown) {
      this.#remove();
      throw error;
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#remove();
  }

  public releaseTouchMove(): void {
    if (!this.#touchMoveActive) return;
    this.#touchMoveActive = false;
    this.element.removeEventListener("touchmove", this.handlers.touchmove);
  }

  public reserveTouchMove(): boolean {
    if (this.#disposed) return false;
    if (this.#touchMoveActive) return true;
    try {
      this.element.addEventListener("touchmove", this.handlers.touchmove, {
        passive: false,
      });
      this.#touchMoveActive = true;
      return true;
    } catch {
      return false;
    }
  }

  #add(): void {
    this.element.addEventListener("pointerdown", this.handlers.pointerdown);
    this.element.addEventListener("pointermove", this.handlers.pointermove);
    this.element.addEventListener("pointerup", this.handlers.pointerup);
    this.element.addEventListener("pointercancel", this.handlers.pointercancel);
    this.element.addEventListener(
      "lostpointercapture",
      this.handlers.lostpointercapture,
    );
    this.element.addEventListener("contextmenu", this.handlers.contextmenu);
    this.element.addEventListener("keydown", this.handlers.keydown);
    this.element.addEventListener("touchstart", this.handlers.touchstart, {
      passive: false,
    });
    this.element.addEventListener("touchend", this.handlers.touchend, {
      passive: false,
    });
    this.element.addEventListener("touchcancel", this.handlers.touchcancel, {
      passive: false,
    });
    this.element.addEventListener("wheel", this.handlers.wheel, {
      passive: false,
    });
  }

  #remove(): void {
    this.releaseTouchMove();
    this.element.removeEventListener("pointerdown", this.handlers.pointerdown);
    this.element.removeEventListener("pointermove", this.handlers.pointermove);
    this.element.removeEventListener("pointerup", this.handlers.pointerup);
    this.element.removeEventListener(
      "pointercancel",
      this.handlers.pointercancel,
    );
    this.element.removeEventListener(
      "lostpointercapture",
      this.handlers.lostpointercapture,
    );
    this.element.removeEventListener("contextmenu", this.handlers.contextmenu);
    this.element.removeEventListener("keydown", this.handlers.keydown);
    this.element.removeEventListener("touchstart", this.handlers.touchstart);
    this.element.removeEventListener("touchend", this.handlers.touchend);
    this.element.removeEventListener("touchcancel", this.handlers.touchcancel);
    this.element.removeEventListener("wheel", this.handlers.wheel);
  }
}

export class PhaseZeroReadingChild
  extends MarkdownRenderChild
  implements Disposable
{
  readonly #observer: MutationObserver;
  #disposed = false;

  public constructor(
    container: HTMLElement,
    window: Window & typeof globalThis,
    private readonly release: () => void,
  ) {
    super(container);
    this.#observer = new window.MutationObserver(() => undefined);
    this.#observer.observe(container, { childList: true, subtree: true });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observer.disconnect();
    try {
      this.release();
    } finally {
      this.unload();
    }
  }

  public override onunload(): void {
    this.dispose();
  }
}

export function applyClaim(
  event: Event | undefined,
  preventDefault: boolean,
  stopPropagation: boolean,
): void {
  if (preventDefault) event?.preventDefault();
  if (stopPropagation) event?.stopPropagation();
}

export function isHtmlElement(value: unknown): value is HTMLElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeType" in value &&
    value.nodeType === ELEMENT_NODE
  );
}

export function readHit(target: EventTarget | null): InputHit {
  if (typeof target === "object" && target !== null) {
    const candidate = target as {
      closest?: (selector: string) => Element | null;
    };
    const element = candidate.closest?.("[data-inkbook-element-id]") as
      HTMLElement | SVGElement | null | undefined;
    const elementId = element?.dataset.inkbookElementId;
    if (elementId !== undefined && elementId.length > 0) {
      return { elementId, kind: "plugin-element" };
    }
  }
  return { kind: "native-markdown" };
}

export function readSectionIdentity(
  section: { readonly lineStart: number; readonly lineEnd: number } | null,
): string | undefined {
  if (
    section === null ||
    !Number.isSafeInteger(section.lineStart) ||
    !Number.isSafeInteger(section.lineEnd) ||
    section.lineStart < 0 ||
    section.lineEnd < section.lineStart
  ) {
    return undefined;
  }
  return `${String(section.lineStart)}:${String(section.lineEnd)}`;
}

export function readingReservationKey(report: ReadingSectionReport): string {
  return `${report.sectionIdentity}:${String(report.generation)}`;
}

export function runDisposalSteps(steps: readonly (() => void)[]): void {
  for (const step of steps) safelyRun(step);
}

export function safelyDispose(resource: Disposable): void {
  safelyRun(() => resource.dispose());
}

export function safelyRelease(element: HTMLElement, pointerId: number): void {
  try {
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch {
    // Disposal remains idempotent if the host already released capture.
  }
}

function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  containerHeight: number,
  limits: Readonly<{
    lineMode: number;
    linePixels: number;
    maximumPixels: number;
    pageFallbackPixels: number;
    pageMode: number;
  }>,
): number | undefined {
  if (!Number.isFinite(deltaY)) return undefined;
  const pagePixels =
    containerHeight > 0 ? containerHeight : limits.pageFallbackPixels;
  let multiplier = 1;
  if (deltaMode === limits.lineMode) multiplier = limits.linePixels;
  if (deltaMode === limits.pageMode) multiplier = pagePixels;
  return Math.min(
    limits.maximumPixels,
    Math.max(-limits.maximumPixels, deltaY * multiplier),
  );
}

export function normalizePhaseZeroWheelDelta(
  deltaY: number,
  deltaMode: number,
  containerHeight: number,
): number | undefined {
  return normalizeWheelDelta(deltaY, deltaMode, containerHeight, {
    lineMode: WHEEL_DELTA_LINE,
    linePixels: WHEEL_LINE_PIXELS,
    maximumPixels: MAX_WHEEL_DELTA_PIXELS,
    pageFallbackPixels: WHEEL_PAGE_FALLBACK_PIXELS,
    pageMode: WHEEL_DELTA_PAGE,
  });
}

function safelyRun(action: () => void): void {
  try {
    action();
  } catch {
    // All remaining resources still require deterministic release.
  }
}
