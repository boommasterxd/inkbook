import {
  MarkdownRenderChild,
  type MarkdownPostProcessorContext,
  type MarkdownView,
} from "obsidian";

import type { ResourceCoordinatorV1 } from "../../../application/resource-coordinator";

import {
  decideInitialPointerOwnership,
  normalizePointerKind,
  OutsideTapSelectionRecognizer,
  SecondaryButtonRouter,
  TwoPointerZoomRecognizer,
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
import {
  applyClaim,
  createPhaseZeroOverlay,
  isHtmlElement,
  PhaseZeroListenerOwner,
  PhaseZeroReadingChild,
  readHit,
  readingReservationKey,
  readSectionIdentity,
  runDisposalSteps,
  safelyDispose,
  safelyRelease,
} from "./phase-zero-view-host-owners";
import {
  PhaseZeroViewOwnership,
  type ReadingGenerationReservation,
} from "./phase-zero-view-ownership";
import { PhaseZeroViewZoom } from "./phase-zero-view-zoom";
import { DirectTouchZoomReservation } from "./direct-touch-zoom-reservation";

const MAX_RETAINED_ANNOTATIONS = 128;
const MAX_READING_SECTION_GENERATIONS = 256;
const GESTURE_SURFACE_CLASS = "inkbook-phase-zero-gesture-surface";

export class PhaseZeroViewRegistry implements ViewResourceFactory, Disposable {
  readonly #bindings = new Map<string, Set<PhaseZeroViewBinding>>();
  readonly #annotations = new Map<string, string | null>();
  #disposed = false;
  #nextBindingId = 1;

  public constructor(private readonly resources: ResourceCoordinatorV1) {}

  public bind(context: ViewResourceContext): Disposable {
    if (this.#disposed) throw new Error("View registry is disposed.");
    const ownerId = `phase-zero-view:${String(this.#nextBindingId)}`;
    this.#nextBindingId += 1;
    const ownership = PhaseZeroViewOwnership.reserve(this.resources, ownerId);
    if (ownership === undefined) return SUSPENDED_VIEW_BINDING;
    const reference: { current?: PhaseZeroViewBinding } = {};
    let binding: PhaseZeroViewBinding;
    try {
      binding = new PhaseZeroViewBinding(context, ownership, () => {
        if (reference.current !== undefined) {
          this.#remove(context.fileIdentity, reference.current);
        }
      });
    } catch (error: unknown) {
      ownership.dispose();
      throw error;
    }
    reference.current = binding;
    const bindings = this.#bindings.get(context.fileIdentity) ?? new Set();
    bindings.add(binding);
    this.#bindings.set(context.fileIdentity, bindings);
    const annotation = this.#annotations.get(context.fileIdentity);
    if (annotation !== undefined) binding.render(annotation);
    return binding;
  }

  public render(fileIdentity: string, annotation: string | null): void {
    if (this.#disposed) return;
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
      for (const binding of [...bindings]) safelyDispose(binding);
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

const SUSPENDED_VIEW_BINDING: Disposable = Object.freeze({
  dispose: (): void => undefined,
});

class PhaseZeroViewBinding implements Disposable {
  readonly #container: HTMLElement;
  readonly #root: HTMLDivElement;
  readonly #svg: SVGSVGElement;
  readonly #marker: SVGCircleElement;
  readonly #listeners: PhaseZeroListenerOwner;
  readonly #ownership: PhaseZeroViewOwnership;
  readonly #viewZoom: PhaseZeroViewZoom;
  readonly #pointerZoom = new TwoPointerZoomRecognizer();
  readonly #directTouchZoom: DirectTouchZoomReservation;
  readonly #secondary = new SecondaryButtonRouter();
  readonly #selectionDismiss = new OutsideTapSelectionRecognizer();
  readonly #contextMenus: PhaseZeroContextMenuController;
  readonly #onDispose: () => void;
  readonly #document: object;
  readonly #window: Window & typeof globalThis;
  readonly #reading: ReadingSectionCoordinator | undefined;
  readonly #sectionGenerations = new Map<string, number>();
  readonly #readingReservations = new Map<
    string,
    ReadingGenerationReservation
  >();
  #disposed = false;

  public constructor(
    context: ViewResourceContext,
    ownership: PhaseZeroViewOwnership,
    onDispose: () => void,
  ) {
    this.#onDispose = onDispose;
    this.#ownership = ownership;
    this.#document = context.document;
    this.#window = context.window as Window & typeof globalThis;
    const view = context.viewIdentity as MarkdownView;
    this.#container = view.containerEl;
    const document = context.document as Document;
    const overlay = createPhaseZeroOverlay(document, context.surface);
    this.#root = overlay.root;
    this.#svg = overlay.svg;
    this.#marker = overlay.marker;
    this.#viewZoom = new PhaseZeroViewZoom(this.#container, this.#svg);
    this.#contextMenus = new PhaseZeroContextMenuController(
      this.#window,
      document,
      this.#marker,
      ownership,
    );
    this.#directTouchZoom = new DirectTouchZoomReservation({
      gestureClaimed: (): void => {
        this.#contextMenus.hostClaimedGesture();
        this.#selectionDismiss.hostClaimedGesture();
      },
      releaseMoveStream: (): void => this.#listeners.releaseTouchMove(),
      reserveMoveStream: (): boolean => this.#listeners.reserveTouchMove(),
      scale: (scaleDelta): void => this.#viewZoom.touch(scaleDelta),
    });
    this.#reading =
      context.surface === "reading"
        ? new ReadingSectionCoordinator(
            { dispose: (): void => undefined },
            {
              create: (report, sectionContext): Disposable => {
                const container = sectionContext.container;
                if (!isHtmlElement(container)) {
                  throw new TypeError(
                    "Reading section container is unavailable.",
                  );
                }
                return this.#createReadingChild(report, container);
              },
            },
          )
        : undefined;
    try {
      this.#container.classList.add(GESTURE_SURFACE_CLASS);
      this.#container.append(this.#root);
      this.#listeners = new PhaseZeroListenerOwner(this.#container, {
        contextmenu: this.#onContextMenu,
        keydown: this.#onKeyDown,
        lostpointercapture: this.#onPointerCancel,
        pointercancel: this.#onPointerCancel,
        pointerdown: this.#onPointerDown,
        pointermove: this.#onPointerMove,
        pointerup: this.#onPointerUp,
        touchcancel: (event): void => this.#directTouchZoom.touchCancel(event),
        touchend: (event): void => this.#directTouchZoom.touchEnd(event),
        touchmove: (event): void => this.#directTouchZoom.touchMove(event),
        touchstart: (event): void => this.#directTouchZoom.touchStart(event),
        wheel: this.#onWheel,
      });
    } catch (error: unknown) {
      runDisposalSteps([
        (): void => this.#directTouchZoom.dispose(),
        (): void => this.#contextMenus.dispose(),
        (): void => this.#reading?.dispose(),
        (): void => this.#root.remove(),
        (): void => this.#container.classList.remove(GESTURE_SURFACE_CLASS),
      ]);
      throw error;
    }
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
    if (
      this.#reading === undefined ||
      element.doc !== this.#document ||
      !this.#container.contains(element)
    ) {
      return;
    }
    if (
      !this.#sectionGenerations.has(sectionIdentity) &&
      this.#sectionGenerations.size >= MAX_READING_SECTION_GENERATIONS
    ) {
      return;
    }
    const generation = (this.#sectionGenerations.get(sectionIdentity) ?? 0) + 1;
    const report: ReadingSectionReport = {
      documentIdentity: context.docId,
      generation,
      previewInstanceIdentity: context.docId,
      sectionIdentity,
      sourcePath: context.sourcePath,
      trustworthySourceEvidence: true,
    };
    const reservation = this.#ownership.prepareReadingGeneration(
      sectionIdentity,
      generation,
    );
    if (reservation === undefined) return;
    const key = readingReservationKey(report);
    this.#readingReservations.set(key, reservation);
    try {
      const result = this.#reading.report(report, {
        addChild: (child): void => {
          if (child instanceof MarkdownRenderChild) context.addChild(child);
          else throw new TypeError("Invalid reading section child.");
        },
        commitOwnership: (): boolean => reservation.commit(),
        container: element,
      });
      if (result !== "accepted") {
        reservation.cancel();
        return;
      }
      this.#sectionGenerations.set(sectionIdentity, generation);
    } catch (error: unknown) {
      reservation.cancel();
      throw error;
    } finally {
      this.#readingReservations.delete(key);
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    runDisposalSteps([
      (): void => this.#directTouchZoom.dispose(),
      (): void => this.#listeners.dispose(),
      (): void => this.#applyZoomResult(this.#pointerZoom.dispose(), undefined),
      (): void =>
        this.#applySecondaryResult(this.#secondary.dispose(), undefined),
      (): void => {
        this.#selectionDismiss.dispose();
      },
      (): void => this.#contextMenus.dispose(),
      (): void => this.#reading?.dispose(),
      (): void => this.#sectionGenerations.clear(),
      (): void => this.#readingReservations.clear(),
      (): void =>
        this.#ownership.releaseAllPointers((pointerId) =>
          safelyRelease(this.#container, pointerId),
        ),
      (): void => this.#root.remove(),
      (): void => this.#container.classList.remove(GESTURE_SURFACE_CLASS),
      (): void => this.#ownership.dispose(),
      this.#onDispose,
    ]);
  }

  #createReadingChild(
    report: ReadingSectionReport,
    container: HTMLElement,
  ): Disposable {
    const reservation = this.#readingReservations.get(
      readingReservationKey(report),
    );
    if (reservation === undefined) {
      throw new Error("Reading section admission is unavailable.");
    }
    return new PhaseZeroReadingChild(container, this.#window, () => {
      reservation.release();
      this.#reading?.forget(report);
      if (
        this.#sectionGenerations.get(report.sectionIdentity) ===
        report.generation
      ) {
        this.#sectionGenerations.delete(report.sectionIdentity);
      }
    });
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
    this.#ownership.releasePointer(event.pointerId, (pointerId) =>
      safelyRelease(this.#container, pointerId),
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
      this.#ownership.capturePointer(
        pointerId,
        (id) => this.#container.setPointerCapture(id),
        (id) => safelyRelease(this.#container, id),
      );
    }
    for (const pointerId of result.releasePointerIds) {
      this.#ownership.releasePointer(pointerId, (id) =>
        safelyRelease(this.#container, id),
      );
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
      this.#ownership.capturePointer(
        result.capturePointerId,
        (id) => this.#container.setPointerCapture(id),
        (id) => safelyRelease(this.#container, id),
      );
    }
    if (result.releasePointerId !== undefined) {
      this.#ownership.releasePointer(result.releasePointerId, (id) =>
        safelyRelease(this.#container, id),
      );
    }
    if (result.panDeltaScreen !== undefined) {
      this.#viewZoom.pan(result.panDeltaScreen);
    }
  }
}
