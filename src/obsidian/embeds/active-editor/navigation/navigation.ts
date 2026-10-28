import type { InputPoint, InputState, PointerSample } from "../../../../editor/input/index";
import type { Bounds } from "../../../../domain/geometry/public";
import { reduceInput } from "../../../../editor/input/index";
import {
  accumulateWheelSteps,
  accumulateZoomInput,
  calculateFitZoom,
  calculateZoomLimits,
  clampCameraX,
  continuousWheelZoomFactor,
  renderedContainerHeight,
  zoomFactorForSteps,
} from "../../../../editor/zoom/index";
import { browserScrollMetrics, type BrowserScrollElement } from "../../../scrolling/index";
import { pointerSampleFromEvent } from "../controller-helpers";
import { measureElementBox, type ElementBoxMeasurement } from "../layout/element-content-box";
import {
  localScreenPointAnchor,
  projectNavigationCursorLayout,
  readNavigationLayout,
  visibleCenterPoint,
  wheelAnchor,
  type NavigationLayoutRead,
  navigationResizeAnchor,
} from "./navigation-layout";
import type { ActiveEditorResizeAnchor, ActiveEditorResizeUpdate } from "../layout/layout-resize";
import type {
  ActiveEditorNavigationOptions,
  ActiveEditorViewState,
  ActiveEditorWheelInput,
} from "./navigation-types";
import {
  horizontalPanWheel,
  isContinuousZoomWheel,
  isZoomWheel,
  positiveOr,
  validViewState,
} from "./navigation-helpers";
import { applyNavigationFrameLayout, resolveNavigationFrame } from "./navigation-frame";
import { NavigationActivity } from "./navigation-activity";
import { ActiveEditorPanMomentum } from "./navigation-momentum";
import { NavigationFeedback } from "./navigation-feedback";
import { validPinchSample } from "./navigation-pinch";
import { NavigationPendingInput } from "./navigation-pending";
export type {
  ActiveEditorNavigationOptions,
  ActiveEditorViewState,
  ActiveEditorWheelInput,
  ActiveEditorZoomLayoutUpdate,
} from "./navigation-types";
export class ActiveEditorNavigation {
  readonly #activity: NavigationActivity;
  readonly #activePageHeight: () => number;
  readonly #applyCamera: NonNullable<ActiveEditorNavigationOptions["applyCamera"]>;
  readonly #applyZoomLayout: ActiveEditorNavigationOptions["applyZoomLayout"];
  readonly #container: HTMLElement;
  #ownerWindow: Window;
  #scrollOwner: BrowserScrollElement;
  readonly #getInput: () => InputState;
  readonly #workScheduler: ActiveEditorNavigationOptions["workScheduler"];
  readonly #setInput: (input: InputState) => void;
  readonly #feedback: NavigationFeedback;
  #cameraX = 0;
  #frame: number | undefined;
  #gestureLayout: NavigationLayoutRead | undefined;
  #origin: { cameraX: number; scrollTop: number; zoom: number } | undefined;
  readonly #pending = new NavigationPendingInput();
  readonly #panMomentum: ActiveEditorPanMomentum;
  readonly #onCancelPinch: ActiveEditorNavigationOptions["onCancelPinch"];
  #zoom: number;
  public constructor(options: ActiveEditorNavigationOptions) {
    this.#activePageHeight = options.activePageHeight;
    this.#applyCamera = options.applyCamera ?? ((camera) => options.renderer.setCamera(camera));
    this.#applyZoomLayout = options.applyZoomLayout;
    this.#container = options.container;
    this.#scrollOwner = options.scrollOwner;
    this.#getInput = options.getInput;
    this.#onCancelPinch = options.onCancelPinch;
    this.#setInput = options.setInput;
    this.#feedback = new NavigationFeedback({
      applyCamera: this.#applyCamera,
      getInput: options.getInput,
      setInput: options.setInput,
    });
    const ownerWindow = options.container.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The active editor requires an owning window.");
    this.#ownerWindow = ownerWindow;
    this.#workScheduler = options.workScheduler;
    this.#activity = new NavigationActivity(ownerWindow, options.onNavigationActive);
    this.#panMomentum = new ActiveEditorPanMomentum(
      () => this.#scheduleFrame(),
      () => this.#ownerWindow.performance?.now() ?? this.#workScheduler.now(),
    );
    this.#zoom = positiveOr(options.getInput().zoom, 1);
  }
  public get cameraX(): number {
    return this.#cameraX;
  }
  public get zoom(): number {
    return this.#zoom;
  }
  public begin(): void {
    const layout =
      this.#gestureLayout === undefined
        ? readNavigationLayout(this.#container, this.#scrollOwner)
        : undefined;
    this.#gestureLayout ??= layout;
    this.#origin ??= {
      cameraX: this.#cameraX,
      scrollTop: layout?.scrollTop ?? browserScrollMetrics.getScrollTop(this.#scrollOwner),
      zoom: this.#zoom,
    };
  }
  public finish(): void {
    this.#origin = undefined;
    this.#gestureLayout = undefined;
    this.#pending.pinch.finish();
  }
  public dispose(): void {
    this.cancelNavigation();
  }
  public readonly getViewState = (): ActiveEditorViewState => ({
    cameraX: this.#cameraX,
    zoom: this.#zoom,
  });
  public beginGestureGeometry(): boolean {
    this.cancelPanMomentum();
    const layout = readNavigationLayout(this.#container, this.#scrollOwner);
    this.#gestureLayout = layout;
    return layout !== undefined;
  }
  public pagePoint(event: Pick<MouseEvent, "clientX" | "clientY">): InputPoint {
    const bounds = measureElementBox(this.#container).contentBox;
    return {
      x: (event.clientX - bounds.left) / this.#zoom - this.#cameraX,
      y: (event.clientY - bounds.top) / this.#zoom,
    };
  }
  public localScreenPoint(event: Pick<MouseEvent, "clientX" | "clientY">): InputPoint {
    const bounds =
      this.#gestureLayout?.containerBounds ?? measureElementBox(this.#container).contentBox;
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }
  public pointer(event: PointerEvent): PointerSample {
    return pointerSampleFromEvent(this.pagePoint(event), event);
  }
  public screenPointer(event: PointerEvent): PointerSample {
    return pointerSampleFromEvent(this.localScreenPoint(event), event);
  }
  public pageSample(sample: PointerSample): PointerSample {
    return {
      ...sample,
      x: sample.x / this.#zoom - this.#cameraX,
      y: sample.y / this.#zoom,
    };
  }
  public pagePointFromScreen(point: InputPoint): InputPoint {
    return { x: point.x / this.#zoom - this.#cameraX, y: point.y / this.#zoom };
  }
  public pan(screenDeltaX: number): void {
    if (!Number.isFinite(screenDeltaX)) return;
    this.begin();
    this.#pending.frame = accumulateZoomInput(this.#pending.frame, { panX: screenDeltaX });
    this.#scheduleFrame();
  }
  public recordTouchPan(screenDeltaX: number, timestamp: number): void {
    this.#panMomentum.recordTouch(screenDeltaX, timestamp);
  }
  public releaseTouchPan(timestamp: number): void {
    this.#panMomentum.releaseTouch(timestamp, this.#zoom > this.#getInput().fitZoom);
  }
  public cancelNavigation(): void {
    const activePinch = this.#pending.pinch.active;
    this.#cancelPendingFrame();
    this.finish();
    if (activePinch) this.#onCancelPinch?.();
  }
  public cancelPanMomentum(): void {
    this.#panMomentum.cancel();
    if (this.#frame !== undefined && !this.#hasPendingFrame()) {
      this.#workScheduler.cancelFrame(this.#frame);
      this.#frame = undefined;
      this.#activity.settle();
    }
  }
  public revert(): void {
    this.#feedback.reset();
    this.cancelPanMomentum();
    const origin = this.#origin;
    this.#cancelPendingFrame();
    if (origin === undefined) {
      this.#gestureLayout = undefined;
      return;
    }
    this.#cameraX = origin.cameraX;
    const changedZoom = this.#zoom !== origin.zoom;
    this.#zoom = origin.zoom;
    const layout = readNavigationLayout(this.#container, this.#scrollOwner);
    this.#applyZoomLayout({
      blockSize: renderedContainerHeight(this.#activePageHeight(), this.#zoom),
      ...(layout === undefined ? {} : { layout }),
      scrollTop: origin.scrollTop,
      zoom: this.#zoom,
    });
    if (changedZoom) {
      this.#setInput(reduceInput(this.#getInput(), { type: "configure", zoom: this.#zoom }).state);
    }
    browserScrollMetrics.setScrollTop(this.#scrollOwner, origin.scrollTop);
    this.#applyCamera({ x: this.#cameraX, zoom: this.#zoom });
    this.#origin = undefined;
    this.#gestureLayout = undefined;
  }
  public scroll(screenDeltaY: number): void {
    if (!Number.isFinite(screenDeltaY)) return;
    this.begin();
    this.#pending.frame = accumulateZoomInput(this.#pending.frame, { panY: screenDeltaY });
    this.#scheduleFrame();
  }
  public setZoom(zoom: number): void {
    if (!Number.isFinite(zoom) || zoom <= 0) return;
    this.#feedback.reset();
    this.cancelNavigation();
    this.#zoom = zoom;
    this.#cameraX = 0;
    this.#setInput(reduceInput(this.#getInput(), { type: "configure", fitZoom: zoom, zoom }).state);
    this.#applyCamera({ x: this.#cameraX, zoom: this.#zoom });
  }
  public restoreViewState(state: ActiveEditorViewState): boolean {
    if (!validViewState(state)) return false;
    this.#feedback.reset();
    this.cancelPanMomentum();
    const layout = readNavigationLayout(this.#container, this.#scrollOwner);
    if (layout === undefined) return false;
    const fitZoom = calculateFitZoom(layout.containerWidth);
    if (fitZoom === undefined) return false;
    this.cancelNavigation();
    this.#zoom = Math.max(fitZoom, Math.min(calculateZoomLimits(fitZoom).maxZoom, state.zoom));
    this.#cameraX = clampCameraX(state.cameraX, layout.containerWidth, this.#zoom);
    const requestedSize = renderedContainerHeight(
      Math.max(0, this.#activePageHeight()),
      this.#zoom,
    );
    const blockSize =
      this.#applyZoomLayout({
        blockSize: requestedSize,
        layout,
        scrollTop: layout.scrollTop,
        zoom: this.#zoom,
      }) ?? requestedSize;
    this.#feedback.apply(
      { x: this.#cameraX, zoom: this.#zoom },
      projectNavigationCursorLayout(layout, {
        blockSize,
        scrollTop: browserScrollMetrics.getScrollTop(this.#scrollOwner),
      }),
      fitZoom,
    );
    return true;
  }
  public readResizeAnchor(
    measurement?: ElementBoxMeasurement,
  ): ActiveEditorResizeAnchor | undefined {
    const layout = readNavigationLayout(this.#container, this.#scrollOwner, measurement);
    if (layout === undefined) return undefined;
    return {
      ...navigationResizeAnchor(layout),
      oldCameraX: this.#cameraX,
    };
  }
  public applyResize(update: ActiveEditorResizeUpdate): boolean {
    if (
      !Number.isFinite(update.cameraX) ||
      !Number.isFinite(update.fitZoom) ||
      update.fitZoom <= 0 ||
      (update.scrollTop !== undefined && !Number.isFinite(update.scrollTop)) ||
      !Number.isFinite(update.zoom) ||
      update.zoom <= 0
    ) {
      return false;
    }
    this.cancelPanMomentum();
    this.#feedback.reset();
    this.cancelNavigation();
    this.#cameraX = update.cameraX;
    this.#zoom = update.zoom;
    this.#setInput(
      reduceInput(this.#getInput(), {
        type: "configure",
        fitZoom: update.fitZoom,
        zoom: update.zoom,
      }).state,
    );
    if (update.scrollTop !== undefined) {
      browserScrollMetrics.setScrollTop(this.#scrollOwner, update.scrollTop);
    }
    this.#applyCamera({ x: update.cameraX, zoom: update.zoom });
    return true;
  }
  public transferScrollOwner(scrollOwner: BrowserScrollElement): boolean {
    if (scrollOwner === this.#scrollOwner) return false;
    const ownerWindow = scrollOwner.ownerDocument.defaultView;
    if (ownerWindow === null) return false;
    this.cancelNavigation();
    this.#activity.transfer(ownerWindow);
    this.#origin = undefined;
    this.#gestureLayout = undefined;
    this.#scrollOwner = scrollOwner;
    this.#ownerWindow = ownerWindow;
    this.#feedback.reset();
    return true;
  }
  public updateKeyboardStep(step: -1 | 1, lastScreenPointer: InputPoint | null): boolean {
    this.cancelPanMomentum();
    this.#pending.anchorSource =
      lastScreenPointer !== null &&
      Number.isFinite(lastScreenPointer.x) &&
      Number.isFinite(lastScreenPointer.y)
        ? (layout) => localScreenPointAnchor(layout, lastScreenPointer)
        : undefined;
    this.#pending.frame = accumulateZoomInput(this.#pending.frame, {
      factor: zoomFactorForSteps(step),
    });
    this.#scheduleFrame();
    return true;
  }
  public beginPinchScreen(anchor: InputPoint): void {
    if (!validPinchSample(anchor)) return;
    this.#cancelPendingFrame();
    this.begin();
    const layout = this.#gestureLayout;
    if (layout === undefined) return;
    this.#pending.pinch.begin(anchor, this.getViewState(), layout);
  }
  public updatePinchScreen(anchor: InputPoint, factor: number): void {
    if (!this.#pending.pinch.active || !validPinchSample(anchor, factor)) return;
    this.#pending.anchorSource = undefined;
    this.#pending.pinch.update(anchor, factor);
    this.#scheduleFrame();
  }
  public notifyScroll(): void {
    this.#activity.pulse();
  }

  public updateWheel(event: ActiveEditorWheelInput): boolean {
    if (!Number.isFinite(event.deltaY) || !Number.isFinite(event.deltaX ?? 0)) return false;
    if (event.deltaY !== 0 || (event.deltaX ?? 0) !== 0) this.#activity.pulse();
    if (isZoomWheel(event)) {
      this.cancelPanMomentum();
      if (event.deltaY === 0) return true;
      const point = { clientX: event.clientX, clientY: event.clientY };
      this.#pending.anchorSource = (layout) => wheelAnchor(layout, point);
      if (isContinuousZoomWheel(event)) {
        this.#pending.continuous = accumulateZoomInput(this.#pending.continuous, {
          factor: continuousWheelZoomFactor(event.deltaY),
        });
      } else {
        this.#pending.wheel = accumulateWheelSteps(this.#pending.wheel, -Math.sign(event.deltaY));
      }
      this.#scheduleFrame();
      return true;
    }
    const horizontal = horizontalPanWheel(event, {});
    if (this.#zoom <= this.#getInput().fitZoom || horizontal === undefined) {
      this.cancelPanMomentum();
      return false;
    }
    const pageHeight =
      event.deltaMode === 2 ? browserScrollMetrics.getClientHeight(this.#scrollOwner) : 0;
    const panX = pageHeight > 0 ? horizontalPanWheel(event, { pageHeight })! : horizontal;
    this.#panMomentum.recordWheel(panX, event);
    this.#pending.frame = accumulateZoomInput(this.#pending.frame, { panX });
    this.#scheduleFrame();
    return true;
  }

  #scheduleFrame(): void {
    this.#activity.hold();
    if (this.#frame !== undefined) return;
    const callback = (timestamp: number): void => {
      this.#frame = undefined;
      this.#applyFrame(timestamp);
      if (this.#hasPendingFrame()) this.#scheduleFrame();
      else this.#activity.settle();
    };
    this.#frame = this.#workScheduler.requestFrame(callback, "input");
  }

  #applyFrame(timestamp: number): void {
    const momentumDelta = this.#panMomentum.advance(timestamp);
    if (momentumDelta !== 0) {
      this.#pending.frame = accumulateZoomInput(this.#pending.frame, {
        panX: momentumDelta,
      });
    }
    const frame = this.#pending.consumeFrame();
    const pinch = this.#pending.pinch.take();
    if (frame.factor === 1 && frame.panX === 0 && frame.panY === 0 && pinch === undefined) return;
    const layout = readNavigationLayout(this.#container, this.#scrollOwner);
    if (layout === undefined) {
      this.cancelPanMomentum();
      return;
    }
    const resolved = resolveNavigationFrame({
      cameraX: this.#cameraX,
      frame:
        this.#pending.anchorSource === undefined
          ? frame
          : { ...frame, anchor: (this.#pending.latestAnchor = this.#pending.anchorSource(layout)) },
      layout,
      pageHeight: this.#activePageHeight,
      scrollOwner: this.#scrollOwner,
      zoom: this.#zoom,
      ...(pinch === undefined ? {} : { pinch }),
    });
    if (resolved === undefined) {
      this.cancelPanMomentum();
      return;
    }
    const appliedLayout = applyNavigationFrameLayout(resolved, layout, {
      applyZoomLayout: this.#applyZoomLayout,
      scrollOwner: this.#scrollOwner,
      previousZoom: this.#zoom,
      panY: frame.panY,
      pinch: pinch !== undefined,
    });
    const previousCameraX = this.#cameraX;
    this.#zoom = resolved.zoom;
    this.#cameraX = resolved.cameraX;
    this.#feedback.apply({ x: this.#cameraX, zoom: this.#zoom }, appliedLayout, resolved.fitZoom);
    if (frame.panX !== 0 && this.#cameraX === previousCameraX) {
      this.cancelPanMomentum();
    }
  }
  public screenPoint(point: InputPoint): InputPoint {
    const bounds =
      this.#gestureLayout?.containerBounds ?? measureElementBox(this.#container).contentBox;
    const local = this.localPointFromPage(point);
    return {
      x: bounds.left + local.x,
      y: bounds.top + local.y,
    };
  }
  public localPointFromPage(point: InputPoint): InputPoint {
    return {
      x: (point.x + this.#cameraX) * this.#zoom,
      y: point.y * this.#zoom,
    };
  }
  public visibleCenter(): InputPoint {
    const layout = readNavigationLayout(this.#container, this.#scrollOwner);
    if (layout === undefined) return { x: 0, y: 0 };
    return visibleCenterPoint(layout, this.#cameraX, this.#zoom);
  }

  public revealBounds(bounds: Bounds): void {
    this.cancelNavigation();
    this.begin();
    const layout = this.#gestureLayout;
    if (layout === undefined) return;
    const viewport = layout.ownerViewport;
    const box = layout.containerBounds;
    const left = Math.max(box.left, viewport.left) + 16;
    const right = Math.min(box.right, viewport.right) - 16;
    const top = viewport.top + 16;
    const bottom = viewport.bottom - 16;
    const x = box.left + (bounds.minX + this.#cameraX) * this.#zoom;
    const y = box.top + bounds.minY * this.#zoom;
    const width = Math.min((bounds.maxX - bounds.minX) * this.#zoom, Math.max(0, right - left));
    const height = Math.min((bounds.maxY - bounds.minY) * this.#zoom, Math.max(0, bottom - top));
    const panX = x < left ? left - x : Math.min(0, right - x - width);
    const panY = y < top ? top - y : Math.min(0, bottom - y - height);
    if (panX === 0 && panY === 0) {
      this.finish();
      return;
    }
    this.#pending.frame = accumulateZoomInput(this.#pending.frame, { panX, panY });
    this.#scheduleFrame();
  }

  #hasPendingFrame(): boolean {
    return this.#panMomentum.active || this.#pending.pending;
  }

  #cancelPendingFrame(): void {
    this.#activity.reset();
    if (this.#frame !== undefined) this.#workScheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#panMomentum.cancel();
    this.#pending.clear();
  }
}
