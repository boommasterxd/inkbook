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
import { DirectTouchZoomReservation } from "./direct-touch-zoom-reservation";
import { PhaseZeroContextMenuController } from "./phase-zero-context-menu";
import { PhaseZeroViewZoom } from "./phase-zero-view-zoom";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ELEMENT_NODE = 1;
const INITIAL_MARKER_X = 48;
const INITIAL_MARKER_Y = 48;
const MARKER_RADIUS = 18;
const MAX_RETAINED_ANNOTATIONS = 128;
const MAX_READING_SECTION_GENERATIONS = 256;
const GESTURE_SURFACE_CLASS = "inkbook-phase-zero-gesture-surface";

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
  readonly #pointerZoom = new TwoPointerZoomRecognizer();
  readonly #directTouchZoom: DirectTouchZoomReservation;
  readonly #viewZoom: PhaseZeroViewZoom;
  readonly #secondary = new SecondaryButtonRouter();
  readonly #selectionDismiss = new OutsideTapSelectionRecognizer();
  readonly #contextMenus: PhaseZeroContextMenuController;
  readonly #onDispose: () => void;
  readonly #document: object;
  readonly #reading: ReadingSectionCoordinator | undefined;
  readonly #sectionGenerations = new Map<string, number>();
  #disposed = false;
  #touchMoveListening = false;

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
    this.#svg.style.transformOrigin = `${String(INITIAL_MARKER_X)}px ${String(INITIAL_MARKER_Y)}px`;
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
    this.#viewZoom = new PhaseZeroViewZoom(this.#container, this.#svg);
    this.#directTouchZoom = new DirectTouchZoomReservation({
      gestureClaimed: (): void => {
        this.#contextMenus.hostClaimedGesture();
        this.#selectionDismiss.hostClaimedGesture();
      },
      releaseMoveStream: (): void => this.#releaseTouchMove(),
      reserveMoveStream: (): boolean => this.#reserveTouchMove(),
      scale: (scaleDelta): void => this.#viewZoom.touch(scaleDelta),
    });
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
    this.#directTouchZoom.dispose();
    this.#unlisten();
    this.#applyZoomResult(this.#pointerZoom.dispose(), undefined);
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
    if (normalizePointerKind(event.pointerType) !== "touch") {
      this.#applyZoomResult(this.#pointerZoom.pointerDown(event), event);
    }
    this.#applySecondaryResult(
      this.#secondary.pointerDown({
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        hit,
        panRangeX: Math.abs(this.#viewZoom.panX),
        panRangeY: Math.abs(this.#viewZoom.panY),
        pointerId: event.pointerId,
        zoomPercent: this.#viewZoom.zoomPercent,
      }),
      event,
    );
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    this.#contextMenus.pointerMove(event);
    this.#selectionDismiss.pointerMove(event);
    if (normalizePointerKind(event.pointerType) !== "touch") {
      this.#applyZoomResult(this.#pointerZoom.pointerMove(event), event);
    }
    this.#applySecondaryResult(this.#secondary.pointerMove(event), event);
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    this.#contextMenus.pointerUp(event);
    if (this.#selectionDismiss.pointerUp(event.pointerId).dismissSelection) {
      this.#marker.classList.remove("is-selected");
    }
    if (normalizePointerKind(event.pointerType) !== "touch") {
      this.#applyZoomResult(
        this.#pointerZoom.pointerUp(event.pointerId),
        event,
      );
    }
    this.#applySecondaryResult(
      this.#secondary.pointerUp(event.pointerId),
      event,
    );
  };

  readonly #onPointerCancel = (event: PointerEvent): void => {
    this.#contextMenus.pointerCancel(event);
    this.#selectionDismiss.pointerCancel(event.pointerId);
    if (normalizePointerKind(event.pointerType) !== "touch") {
      this.#applyZoomResult(
        this.#pointerZoom.pointerCancel(event.pointerId),
        event,
      );
    }
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
    this.#viewZoom.wheel(event);
  };

  readonly #onTouchStart = (event: TouchEvent): void => {
    this.#directTouchZoom.touchStart(event);
  };

  readonly #onTouchMove = (event: TouchEvent): void => {
    this.#directTouchZoom.touchMove(event);
  };

  readonly #onTouchEnd = (event: TouchEvent): void => {
    this.#directTouchZoom.touchEnd(event);
  };

  readonly #onTouchCancel = (event: TouchEvent): void => {
    this.#directTouchZoom.touchCancel(event);
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
    this.#viewZoom.touch(result.zoom.scaleDelta);
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
      this.#viewZoom.pan(result.panDeltaScreen);
    }
  }

  #listen(): void {
    this.#container.addEventListener("pointerdown", this.#onPointerDown);
    this.#container.addEventListener("pointermove", this.#onPointerMove);
    this.#container.addEventListener("pointerup", this.#onPointerUp);
    this.#container.addEventListener("pointercancel", this.#onPointerCancel);
    this.#container.addEventListener(
      "lostpointercapture",
      this.#onPointerCancel,
    );
    this.#container.addEventListener("contextmenu", this.#onContextMenu);
    this.#container.addEventListener("keydown", this.#onKeyDown);
    this.#container.addEventListener("touchstart", this.#onTouchStart, {
      passive: false,
    });
    this.#container.addEventListener("touchend", this.#onTouchEnd);
    this.#container.addEventListener("touchcancel", this.#onTouchCancel);
    this.#container.addEventListener("wheel", this.#onWheel, {
      passive: false,
    });
  }

  #unlisten(): void {
    this.#container.removeEventListener("pointerdown", this.#onPointerDown);
    this.#container.removeEventListener("pointermove", this.#onPointerMove);
    this.#container.removeEventListener("pointerup", this.#onPointerUp);
    this.#container.removeEventListener("pointercancel", this.#onPointerCancel);
    this.#container.removeEventListener(
      "lostpointercapture",
      this.#onPointerCancel,
    );
    this.#container.removeEventListener("contextmenu", this.#onContextMenu);
    this.#container.removeEventListener("keydown", this.#onKeyDown);
    this.#container.removeEventListener("touchstart", this.#onTouchStart);
    this.#container.removeEventListener("touchend", this.#onTouchEnd);
    this.#container.removeEventListener("touchcancel", this.#onTouchCancel);
    this.#container.removeEventListener("wheel", this.#onWheel);
    this.#releaseTouchMove();
  }

  #reserveTouchMove(): boolean {
    if (this.#touchMoveListening) return true;
    try {
      this.#container.addEventListener("touchmove", this.#onTouchMove, {
        passive: false,
      });
      this.#touchMoveListening = true;
      return true;
    } catch {
      return false;
    }
  }

  #releaseTouchMove(): void {
    if (!this.#touchMoveListening) return;
    this.#touchMoveListening = false;
    this.#container.removeEventListener("touchmove", this.#onTouchMove);
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
