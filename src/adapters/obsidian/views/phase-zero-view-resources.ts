import {
  MarkdownRenderChild,
  type MarkdownPostProcessorContext,
  type MarkdownView,
} from "obsidian";

import {
  decideInitialPointerOwnership,
  normalizePointerKind,
  OutsideTapSelectionRecognizer,
  SecondaryButtonRouter,
  TwoPointerZoomRecognizer,
  type InputHit,
  type SecondaryButtonResult,
  type TwoPointerZoomResult,
} from "../../../input/phase-zero";
import type {
  Disposable,
  ViewResourceContext,
  ViewResourceFactory,
} from "./contracts";
import {
  ReadingSectionCoordinator,
  type ReadingSectionReport,
} from "./reading-section-coordinator";
import { PhaseZeroContextMenuController } from "./phase-zero-context-menu";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ELEMENT_NODE = 1;
const MIN_ZOOM_PERCENT = 50;
const MAX_ZOOM_PERCENT = 400;
const INITIAL_MARKER_X = 48;
const INITIAL_MARKER_Y = 48;
const MARKER_RADIUS = 18;
const DEFAULT_ZOOM_PERCENT = 100;
const MAX_RETAINED_ANNOTATIONS = 128;
const MAX_READING_SECTION_GENERATIONS = 256;
const GESTURE_SURFACE_CLASS = "inkbook-phase-zero-gesture-surface";
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const WHEEL_LINE_PIXELS = 16;
const WHEEL_PAGE_FALLBACK_PIXELS = 800;
const MAX_WHEEL_DELTA_PIXELS = 120;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

export class PhaseZeroViewRegistry implements ViewResourceFactory, Disposable {
  readonly #bindings = new Map<string, Set<PhaseZeroViewBinding>>();
  readonly #annotations = new Map<string, string | null>();
  #disposed = false;

  public bind(context: ViewResourceContext): Disposable {
    if (this.#disposed) throw new Error("View registry is disposed.");
    const reference: { current?: PhaseZeroViewBinding } = {};
    const binding = new PhaseZeroViewBinding(context, () => {
      if (reference.current !== undefined) {
        this.#remove(context.fileIdentity, reference.current);
      }
    });
    reference.current = binding;
    const bindings = this.#bindings.get(context.fileIdentity) ?? new Set();
    bindings.add(binding);
    this.#bindings.set(context.fileIdentity, bindings);
    const annotation = this.#annotations.get(context.fileIdentity);
    if (annotation !== undefined) binding.render(annotation);
    return binding;
  }

  public render(fileIdentity: string, annotation: string | null): void {
    this.#retainAnnotation(fileIdentity, annotation);
    for (const binding of this.#bindings.get(fileIdentity) ?? []) {
      binding.render(annotation);
    }
  }

  public reportReadingSection(
    element: HTMLElement,
    context: MarkdownPostProcessorContext,
  ): void {
    const section = context.getSectionInfo(element);
    const sectionIdentity = readSectionIdentity(section);
    if (sectionIdentity === undefined) return;
    for (const binding of this.#bindings.get(context.sourcePath) ?? []) {
      binding.reportReadingSection(element, context, sectionIdentity);
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const bindings of this.#bindings.values()) {
      for (const binding of [...bindings]) binding.dispose();
    }
    this.#bindings.clear();
    this.#annotations.clear();
  }

  #remove(fileIdentity: string, binding: PhaseZeroViewBinding): void {
    const bindings = this.#bindings.get(fileIdentity);
    bindings?.delete(binding);
    if (bindings?.size === 0) this.#bindings.delete(fileIdentity);
  }

  #retainAnnotation(fileIdentity: string, annotation: string | null): void {
    this.#annotations.delete(fileIdentity);
    this.#annotations.set(fileIdentity, annotation);
    if (this.#annotations.size <= MAX_RETAINED_ANNOTATIONS) return;
    const oldest = this.#annotations.keys().next().value;
    if (oldest !== undefined) this.#annotations.delete(oldest);
  }
}

class PhaseZeroViewBinding implements Disposable {
  readonly #container: HTMLElement;
  readonly #root: HTMLDivElement;
  readonly #svg: SVGSVGElement;
  readonly #marker: SVGCircleElement;
  readonly #zoom = new TwoPointerZoomRecognizer();
  readonly #secondary = new SecondaryButtonRouter();
  readonly #selectionDismiss = new OutsideTapSelectionRecognizer();
  readonly #contextMenus: PhaseZeroContextMenuController;
  readonly #onDispose: () => void;
  readonly #document: object;
  readonly #reading: ReadingSectionCoordinator | undefined;
  readonly #sectionGenerations = new Map<string, number>();
  #disposed = false;
  #zoomPercent = DEFAULT_ZOOM_PERCENT;
  #panX = 0;
  #panY = 0;

  public constructor(context: ViewResourceContext, onDispose: () => void) {
    this.#onDispose = onDispose;
    this.#document = context.document;
    const view = context.viewIdentity as MarkdownView;
    this.#container = view.containerEl;
    this.#container.classList.add(GESTURE_SURFACE_CLASS);
    const document = context.document as Document;
    this.#root = document.createElement("div");
    this.#root.className = "inkbook-phase-zero-overlay";
    this.#root.dataset.inkbookSurface = context.surface;
    this.#svg = document.createElementNS(SVG_NAMESPACE, "svg");
    this.#svg.setAttribute("aria-label", "Inkbook Phase 0 annotation layer");
    this.#svg.setAttribute("role", "img");
    this.#marker = document.createElementNS(SVG_NAMESPACE, "circle");
    this.#marker.classList.add("inkbook-phase-zero-marker");
    this.#marker.dataset.inkbookElementId = "phase-zero-annotation";
    this.#marker.setAttribute("cx", String(INITIAL_MARKER_X));
    this.#marker.setAttribute("cy", String(INITIAL_MARKER_Y));
    this.#marker.setAttribute("r", String(MARKER_RADIUS));
    this.#marker.setAttribute("tabindex", "0");
    this.#marker.setAttribute("aria-label", "Phase 0 annotation probe");
    this.#contextMenus = new PhaseZeroContextMenuController(
      context.window as Window,
      document,
      this.#marker,
    );
    this.#svg.append(this.#marker);
    this.#root.append(this.#svg);
    this.#container.append(this.#root);
    this.#reading =
      context.surface === "reading"
        ? new ReadingSectionCoordinator(
            { dispose: (): void => undefined },
            {
              create: (_report, sectionContext): Disposable => {
                const container = sectionContext.container;
                if (!isHtmlElement(container)) {
                  throw new TypeError(
                    "Reading section container is unavailable.",
                  );
                }
                return new PhaseZeroReadingChild(container);
              },
            },
          )
        : undefined;
    this.#listen();
  }

  public render(annotation: string | null): void {
    this.#marker.classList.toggle("is-visible", annotation !== null);
    this.#marker.setAttribute("aria-hidden", String(annotation === null));
    this.#marker.dataset.annotation = annotation ?? "";
  }

  public reportReadingSection(
    element: HTMLElement,
    context: MarkdownPostProcessorContext,
    sectionIdentity: string,
  ): void {
    if (this.#reading === undefined || element.doc !== this.#document) return;
    if (
      !this.#sectionGenerations.has(sectionIdentity) &&
      this.#sectionGenerations.size >= MAX_READING_SECTION_GENERATIONS
    ) {
      return;
    }
    const generation = (this.#sectionGenerations.get(sectionIdentity) ?? 0) + 1;
    this.#sectionGenerations.set(sectionIdentity, generation);
    const report: ReadingSectionReport = {
      documentIdentity: context.docId,
      generation,
      previewInstanceIdentity: context.docId,
      sectionIdentity,
      sourcePath: context.sourcePath,
      trustworthySourceEvidence: true,
    };
    this.#reading.report(report, {
      addChild: (child): void => {
        if (child instanceof MarkdownRenderChild) context.addChild(child);
        else throw new TypeError("Invalid reading section child.");
      },
      container: element,
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unlisten();
    this.#applyZoomResult(this.#zoom.dispose(), undefined);
    this.#applySecondaryResult(this.#secondary.dispose(), undefined);
    this.#selectionDismiss.dispose();
    this.#contextMenus.dispose();
    this.#reading?.dispose();
    this.#sectionGenerations.clear();
    this.#root.remove();
    this.#container.classList.remove(GESTURE_SURFACE_CLASS);
    this.#onDispose();
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    const hit = readHit(event.target);
    this.#contextMenus.pointerDown(event, hit);
    this.#selectionDismiss.pointerDown({
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      hit,
      pointerId: event.pointerId,
      pointerKind: normalizePointerKind(event.pointerType),
      selectionActive: this.#marker.classList.contains("is-selected"),
    });
    const decision = decideInitialPointerOwnership({
      activeTool: "cursor",
      button: event.button,
      hit,
      pointerKind: normalizePointerKind(event.pointerType),
    });
    if (decision.action === "select-plugin-target") {
      applyClaim(event, decision.preventDefault, decision.stopPropagation);
      this.#marker.classList.add("is-selected");
    }
    this.#applyZoomResult(this.#zoom.pointerDown(event), event);
    this.#applySecondaryResult(
      this.#secondary.pointerDown({
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        hit,
        panRangeX: Math.abs(this.#panX),
        panRangeY: Math.abs(this.#panY),
        pointerId: event.pointerId,
        zoomPercent: this.#zoomPercent,
      }),
      event,
    );
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    this.#contextMenus.pointerMove(event);
    this.#selectionDismiss.pointerMove(event);
    this.#applyZoomResult(this.#zoom.pointerMove(event), event);
    this.#applySecondaryResult(this.#secondary.pointerMove(event), event);
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    this.#contextMenus.pointerUp(event);
    if (this.#selectionDismiss.pointerUp(event.pointerId).dismissSelection) {
      this.#marker.classList.remove("is-selected");
    }
    this.#applyZoomResult(this.#zoom.pointerUp(event.pointerId), event);
    this.#applySecondaryResult(
      this.#secondary.pointerUp(event.pointerId),
      event,
    );
  };

  readonly #onPointerCancel = (event: PointerEvent): void => {
    this.#contextMenus.pointerCancel(event);
    this.#selectionDismiss.pointerCancel(event.pointerId);
    this.#applyZoomResult(this.#zoom.pointerCancel(event.pointerId), event);
    this.#applySecondaryResult(
      this.#secondary.pointerCancel(event.pointerId),
      event,
    );
  };

  readonly #onContextMenu = (event: MouseEvent): void => {
    if (this.#contextMenus.contextMenu(event)) return;
    const result = this.#secondary.contextMenu();
    this.#applySecondaryResult(result, event);
    if (result.action !== "plugin-menu") return;
    this.#contextMenus.showPointerMenu(event);
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    this.#contextMenus.keyDown(event);
  };

  readonly #onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey || event.defaultPrevented) return;
    const deltaPixels = normalizeWheelDelta(
      event,
      this.#container.clientHeight,
    );
    if (deltaPixels === undefined || deltaPixels === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.#applyScaleDelta(Math.exp(-deltaPixels * WHEEL_ZOOM_SENSITIVITY));
  };

  #applyZoomResult(
    result: TwoPointerZoomResult,
    event: PointerEvent | undefined,
  ): void {
    applyClaim(event, result.preventDefault, result.stopPropagation);
    if (result.handled) {
      this.#contextMenus.hostClaimedGesture();
      this.#selectionDismiss.hostClaimedGesture();
    }
    for (const pointerId of result.capturePointerIds) {
      safelyCapture(this.#container, pointerId);
    }
    for (const pointerId of result.releasePointerIds) {
      safelyRelease(this.#container, pointerId);
    }
    if (result.zoom === undefined) return;
    this.#applyScaleDelta(result.zoom.scaleDelta);
  }

  #applyScaleDelta(scaleDelta: number): void {
    if (!Number.isFinite(scaleDelta) || scaleDelta <= 0) return;
    this.#zoomPercent = clamp(
      this.#zoomPercent * scaleDelta,
      MIN_ZOOM_PERCENT,
      MAX_ZOOM_PERCENT,
    );
    this.#updateTransform();
  }

  #applySecondaryResult(
    result: SecondaryButtonResult,
    event: Event | undefined,
  ): void {
    applyClaim(event, result.preventDefault, result.stopPropagation);
    if (result.capturePointerId !== undefined) {
      safelyCapture(this.#container, result.capturePointerId);
    }
    if (result.releasePointerId !== undefined) {
      safelyRelease(this.#container, result.releasePointerId);
    }
    if (result.panDeltaScreen !== undefined) {
      this.#panX += result.panDeltaScreen.x;
      this.#panY += result.panDeltaScreen.y;
      this.#updateTransform();
    }
  }

  #updateTransform(): void {
    const scale = this.#zoomPercent / DEFAULT_ZOOM_PERCENT;
    this.#svg.style.transform = `translate(${String(this.#panX)}px, ${String(this.#panY)}px) scale(${String(scale)})`;
  }

  #listen(): void {
    this.#container.addEventListener("pointerdown", this.#onPointerDown);
    this.#container.addEventListener("pointermove", this.#onPointerMove);
    this.#container.addEventListener("pointerup", this.#onPointerUp);
    this.#container.addEventListener("pointercancel", this.#onPointerCancel);
    this.#container.addEventListener("contextmenu", this.#onContextMenu);
    this.#container.addEventListener("keydown", this.#onKeyDown);
    this.#container.addEventListener("wheel", this.#onWheel, {
      passive: false,
    });
  }

  #unlisten(): void {
    this.#container.removeEventListener("pointerdown", this.#onPointerDown);
    this.#container.removeEventListener("pointermove", this.#onPointerMove);
    this.#container.removeEventListener("pointerup", this.#onPointerUp);
    this.#container.removeEventListener("pointercancel", this.#onPointerCancel);
    this.#container.removeEventListener("contextmenu", this.#onContextMenu);
    this.#container.removeEventListener("keydown", this.#onKeyDown);
    this.#container.removeEventListener("wheel", this.#onWheel);
  }
}

class PhaseZeroReadingChild extends MarkdownRenderChild implements Disposable {
  #disposed = false;

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.unload();
  }
}

function readHit(target: EventTarget | null): InputHit {
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

function readSectionIdentity(
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

function isHtmlElement(value: unknown): value is HTMLElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeType" in value &&
    value.nodeType === ELEMENT_NODE
  );
}

function applyClaim(
  event: Event | undefined,
  preventDefault: boolean,
  stopPropagation: boolean,
): void {
  if (preventDefault) event?.preventDefault();
  if (stopPropagation) event?.stopPropagation();
}

function safelyCapture(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // A host may release the pointer before the recognizer claims it.
  }
}

function safelyRelease(element: HTMLElement, pointerId: number): void {
  try {
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch {
    // Disposal remains idempotent if the host already released capture.
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeWheelDelta(
  event: WheelEvent,
  containerHeight: number,
): number | undefined {
  if (!Number.isFinite(event.deltaY)) return undefined;
  const pagePixels =
    containerHeight > 0 ? containerHeight : WHEEL_PAGE_FALLBACK_PIXELS;
  let multiplier = 1;
  if (event.deltaMode === WHEEL_DELTA_LINE) multiplier = WHEEL_LINE_PIXELS;
  if (event.deltaMode === WHEEL_DELTA_PAGE) multiplier = pagePixels;
  return clamp(
    event.deltaY * multiplier,
    -MAX_WHEEL_DELTA_PIXELS,
    MAX_WHEEL_DELTA_PIXELS,
  );
}
