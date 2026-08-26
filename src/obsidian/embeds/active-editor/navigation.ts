import type { InputPoint, InputState, PointerSample } from "../../../editor/input/index";
import { reduceInput } from "../../../editor/input/index";
import {
  accumulateWheelSteps,
  accumulateZoomInput,
  calculateFitZoom,
  calculateZoomLimits,
  clampCameraX,
  consumeWheelFrame,
  consumeZoomFrame,
  continuousWheelZoomFactor,
  createWheelZoomState,
  createZoomFrameState,
  keyboardZoomFactor,
  renderedContainerHeight,
  zoomFrameHasPending,
  type WheelZoomState,
  type ZoomAnchor,
  type ZoomFrameState,
} from "../../../editor/zoom/index";
import { browserScrollMetrics, type BrowserScrollElement } from "../../scrolling/index";
import { normalizePointerType } from "./controller-helpers";
import { measureElementBox } from "./element-content-box";
import {
  localScreenPointAnchor,
  pagePointAnchor,
  readNavigationLayout,
  visibleCenterPoint,
  wheelAnchor,
  type NavigationLayoutRead,
  readOwnerScrollBounds,
} from "./navigation-layout";
import type { ActiveEditorResizeAnchor, ActiveEditorResizeUpdate } from "./layout-resize";
import type {
  ActiveEditorCameraUpdate,
  ActiveEditorNavigationOptions,
  ActiveEditorViewState,
  ActiveEditorWheelInput,
  ActiveEditorZoomLayoutUpdate,
} from "./navigation-types";
import {
  horizontalPanWheel,
  isContinuousZoomWheel,
  isZoomWheel,
  positiveOr,
  validViewState,
} from "./navigation-helpers";
import { resolveNavigationFrame } from "./navigation-frame";
import { ActiveEditorPanMomentum } from "./navigation-momentum";
export type {
  ActiveEditorCameraUpdate,
  ActiveEditorNavigationOptions,
  ActiveEditorViewState,
  ActiveEditorWheelInput,
  ActiveEditorZoomLayoutUpdate,
} from "./navigation-types";
export class ActiveEditorNavigation {
  readonly #activePageHeight: () => number;
  readonly #applyCamera: (camera: ActiveEditorCameraUpdate) => void;
  readonly #applyZoomLayout: (update: ActiveEditorZoomLayoutUpdate) => void;
  readonly #container: HTMLElement;
  #scrollOwner: BrowserScrollElement;
  readonly #getInput: () => InputState;
  #ownerWindow: Window;
  readonly #setInput: (input: InputState) => void;
  #cameraX = 0;
  #frame: number | undefined;
  #frameState: ZoomFrameState = createZoomFrameState();
  #gestureLayout: NavigationLayoutRead | undefined;
  #latestAnchor: ZoomAnchor | undefined;
  #origin: { cameraX: number; scrollTop: number } | undefined;
  #pendingLayout: NavigationLayoutRead | undefined;
  readonly #panMomentum: ActiveEditorPanMomentum;
  #wheelState: WheelZoomState = createWheelZoomState();
  #zoom: number;

  public constructor(options: ActiveEditorNavigationOptions) {
    this.#activePageHeight = options.activePageHeight;
    this.#applyCamera = options.applyCamera ?? ((camera) => options.renderer.setCamera(camera));
    this.#applyZoomLayout = options.applyZoomLayout;
    this.#container = options.container;
    this.#scrollOwner = options.scrollOwner;
    this.#getInput = options.getInput;
    this.#setInput = options.setInput;
    const ownerWindow = options.container.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The active editor requires an owning window.");
    this.#ownerWindow = ownerWindow;
    this.#panMomentum = new ActiveEditorPanMomentum(ownerWindow, () => this.#scheduleFrame());
    this.#zoom = positiveOr(options.getInput().zoom, 1);
  }

  public get cameraX(): number {
    return this.#cameraX;
  }

  public get zoom(): number {
    return this.#zoom;
  }

  public begin(): void {
    this.#gestureLayout ??= readNavigationLayout(this.#container, this.#scrollOwner);
    this.#origin ??= {
      cameraX: this.#cameraX,
      scrollTop: browserScrollMetrics.getScrollTop(this.#scrollOwner),
    };
  }

  public finish(): void {
    this.#origin = undefined;
    this.#gestureLayout = undefined;
  }

  public dispose(): void {
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#clearPendingFrame();
    this.#gestureLayout = undefined;
    this.#origin = undefined;
  }

  public getViewState(): ActiveEditorViewState {
    return { cameraX: this.#cameraX, zoom: this.#zoom };
  }

  public beginGestureGeometry(): boolean {
    this.cancelPanMomentum();
    const layout = readNavigationLayout(this.#container, this.#scrollOwner);
    this.#gestureLayout = layout;
    return layout !== undefined;
  }

  public pagePoint(event: Pick<MouseEvent, "clientX" | "clientY">): InputPoint {
    const bounds =
      this.#gestureLayout?.containerBounds ?? measureElementBox(this.#container).contentBox;
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
    return {
      ...this.pagePoint(event),
      pointerId: event.pointerId,
      pointerType: normalizePointerType(event.pointerType),
      pressure: event.pressure,
    };
  }

  public screenPointer(event: PointerEvent): PointerSample {
    const bounds =
      this.#gestureLayout?.containerBounds ?? measureElementBox(this.#container).contentBox;
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      pointerId: event.pointerId,
      pointerType: normalizePointerType(event.pointerType),
      pressure: event.pressure,
    };
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
    this.#frameState = accumulateZoomInput(this.#frameState, { panX: screenDeltaX });
    this.#scheduleFrame();
  }

  public recordTouchPan(screenDeltaX: number, timestamp: number): void {
    this.#panMomentum.recordTouch(screenDeltaX, timestamp);
  }
  public releaseTouchPan(timestamp: number): void {
    this.#panMomentum.releaseTouch(timestamp, this.#zoom > this.#getInput().fitZoom);
  }

  public cancelPanMomentum(): void {
    this.#panMomentum.cancel();
    if (this.#frame !== undefined && !this.#hasPendingFrame()) {
      this.#ownerWindow.cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
    }
  }

  public revert(): void {
    this.cancelPanMomentum();
    const origin = this.#origin;
    if (origin === undefined) return;
    this.#cancelPendingFrame();
    this.#cameraX = origin.cameraX;
    browserScrollMetrics.setScrollTop(this.#scrollOwner, origin.scrollTop);
    this.#applyCamera({ x: this.#cameraX, zoom: this.#zoom });
    this.#origin = undefined;
    this.#gestureLayout = undefined;
  }

  public scroll(screenDeltaY: number): void {
    if (!Number.isFinite(screenDeltaY)) return;
    this.begin();
    this.#frameState = accumulateZoomInput(this.#frameState, { panY: screenDeltaY });
    this.#scheduleFrame();
  }

  public setZoom(zoom: number): void {
    if (!Number.isFinite(zoom) || zoom <= 0) return;
    this.cancelPanMomentum();
    this.#zoom = zoom;
    this.#cameraX = 0;
    this.#setInput(reduceInput(this.#getInput(), { type: "configure", fitZoom: zoom, zoom }).state);
    this.#applyCamera({ x: this.#cameraX, zoom: this.#zoom });
  }

  public restoreViewState(state: ActiveEditorViewState): boolean {
    if (!validViewState(state)) return false;
    this.cancelPanMomentum();
    const layout = readNavigationLayout(this.#container, this.#scrollOwner);
    if (layout === undefined) return false;
    const fitZoom = calculateFitZoom(layout.containerWidth);
    if (fitZoom === undefined) return false;
    this.#zoom = Math.max(fitZoom, Math.min(calculateZoomLimits(fitZoom).maxZoom, state.zoom));
    this.#cameraX = clampCameraX(state.cameraX, layout.containerWidth, this.#zoom);
    this.#applyZoomLayout({
      blockSize: renderedContainerHeight(Math.max(0, this.#activePageHeight()), this.#zoom),
      zoom: this.#zoom,
    });
    this.#setInput(
      reduceInput(this.#getInput(), { type: "configure", fitZoom, zoom: this.#zoom }).state,
    );
    this.#applyCamera({ x: this.#cameraX, zoom: this.#zoom });
    return true;
  }

  public readResizeAnchor(): ActiveEditorResizeAnchor | undefined {
    const layout = readNavigationLayout(this.#container, this.#scrollOwner);
    if (layout === undefined) return undefined;
    return {
      anchorViewportY: (layout.ownerViewport.bottom - layout.ownerViewport.top) / 2,
      embedTopInScrollContent: layout.embedTopInScrollContent,
      oldCameraX: this.#cameraX,
      oldRenderedContainerHeight: layout.containerBorderBounds.height,
      oldScrollTop: layout.scrollTop,
      scrollBounds: readOwnerScrollBounds(this.#scrollOwner),
      viewportWidth: layout.containerWidth,
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
    this.#cancelPendingFrame();
    this.#cameraX = update.cameraX;
    this.#zoom = update.zoom;
    this.#setInput(
      reduceInput(this.#getInput(), {
        type: "configure",
        fitZoom: update.fitZoom,
        zoom: update.zoom,
      }).state,
    );
    this.#applyCamera({ x: update.cameraX, zoom: update.zoom });
    if (update.scrollTop !== undefined) {
      browserScrollMetrics.setScrollTop(this.#scrollOwner, update.scrollTop);
    }
    return true;
  }

  public transferScrollOwner(scrollOwner: BrowserScrollElement): boolean {
    if (scrollOwner === this.#scrollOwner) return false;
    const ownerWindow = scrollOwner.ownerDocument.defaultView;
    if (ownerWindow === null) return false;
    this.cancelPanMomentum();
    this.#cancelPendingFrame();
    this.#origin = undefined;
    this.#gestureLayout = undefined;
    this.#scrollOwner = scrollOwner;
    this.#ownerWindow = ownerWindow;
    this.#panMomentum.transferOwnerWindow(ownerWindow);
    return true;
  }

  public updateKeyboard(
    event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
    lastScreenPointer: InputPoint | null,
  ): boolean {
    const factor = keyboardZoomFactor(event);
    if (factor === undefined) return false;
    this.cancelPanMomentum();
    const layout = this.#pendingLayout ?? readNavigationLayout(this.#container, this.#scrollOwner);
    const anchor =
      lastScreenPointer !== null &&
      Number.isFinite(lastScreenPointer.x) &&
      Number.isFinite(lastScreenPointer.y) &&
      layout !== undefined
        ? localScreenPointAnchor(layout, lastScreenPointer)
        : undefined;
    if (layout !== undefined) this.#pendingLayout = layout;
    if (anchor !== undefined) this.#latestAnchor = anchor;
    this.#frameState = accumulateZoomInput(this.#frameState, {
      ...(anchor === undefined ? {} : { anchor }),
      factor,
    });
    this.#scheduleFrame();
    return true;
  }

  public updatePinch(anchor: InputPoint, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.cancelPanMomentum();
    this.begin();
    const layout = this.#gestureLayout ?? readNavigationLayout(this.#container, this.#scrollOwner);
    if (layout === undefined) return;
    this.#latestAnchor = pagePointAnchor(layout, anchor, this.#cameraX, this.#zoom);
    this.#frameState = accumulateZoomInput(this.#frameState, {
      anchor: this.#latestAnchor,
      factor,
    });
    this.#scheduleFrame();
  }

  public updatePinchScreen(anchor: InputPoint, factor: number): void {
    this.updatePinch(this.pagePointFromScreen(anchor), factor);
  }

  public updateWheel(event: ActiveEditorWheelInput): boolean {
    if (!Number.isFinite(event.deltaY) || !Number.isFinite(event.deltaX ?? 0)) return false;
    this.#panMomentum.prepareWheel(isZoomWheel(event));
    const ownerPageHeight = browserScrollMetrics.getClientHeight(this.#scrollOwner);
    const normalization = ownerPageHeight > 0 ? { pageHeight: ownerPageHeight } : {};
    if (isZoomWheel(event)) {
      const layout =
        this.#pendingLayout ?? readNavigationLayout(this.#container, this.#scrollOwner);
      if (layout === undefined) return false;
      this.#pendingLayout = layout;
      this.#latestAnchor = wheelAnchor(layout, event);
      if (isContinuousZoomWheel(event)) {
        this.#frameState = accumulateZoomInput(this.#frameState, {
          anchor: this.#latestAnchor,
          factor: continuousWheelZoomFactor(event.deltaY, normalization),
        });
      } else {
        this.#wheelState = accumulateWheelSteps(this.#wheelState, -Math.sign(event.deltaY));
      }
      this.#scheduleFrame();
      return true;
    }
    if (this.#zoom <= this.#getInput().fitZoom) {
      this.#panMomentum.cancelTrackpad();
      return false;
    }
    const panX = horizontalPanWheel(event, normalization);
    if (panX === undefined) {
      this.#panMomentum.cancelTrackpad();
      return false;
    }
    this.#frameState = accumulateZoomInput(this.#frameState, { panX });
    if (!this.#panMomentum.recordTrackpadWheel(panX, event)) {
      this.#panMomentum.cancelTrackpad();
    }
    this.#scheduleFrame();
    return true;
  }

  #scheduleFrame(): void {
    if (this.#frame !== undefined) return;
    this.#frame = this.#ownerWindow.requestAnimationFrame((timestamp) => {
      this.#frame = undefined;
      this.#applyFrame(timestamp);
      if (this.#hasPendingFrame()) this.#scheduleFrame();
    });
  }

  #applyFrame(timestamp: number): void {
    const momentumDelta = this.#panMomentum.advance(timestamp);
    if (momentumDelta !== 0) {
      this.#frameState = accumulateZoomInput(this.#frameState, {
        panX: momentumDelta,
      });
    }
    const wheel = consumeWheelFrame(this.#wheelState);
    this.#wheelState = wheel.state;
    if (wheel.frame.factor !== 1) {
      this.#frameState = accumulateZoomInput(this.#frameState, {
        factor: wheel.frame.factor,
        ...(this.#latestAnchor === undefined ? {} : { anchor: this.#latestAnchor }),
      });
    }
    const reduction = consumeZoomFrame(this.#frameState);
    this.#frameState = reduction.state;
    const frame = reduction.frame;
    if (frame.factor === 1 && frame.panX === 0 && frame.panY === 0) return;
    const layout = this.#pendingLayout ?? readNavigationLayout(this.#container, this.#scrollOwner);
    this.#pendingLayout = undefined;
    if (layout === undefined) {
      this.cancelPanMomentum();
      return;
    }
    const resolved = resolveNavigationFrame({
      cameraX: this.#cameraX,
      frame,
      layout,
      pageHeight: Math.max(0, this.#activePageHeight()),
      scrollOwner: this.#scrollOwner,
      zoom: this.#zoom,
    });
    if (resolved === undefined) {
      this.cancelPanMomentum();
      return;
    }
    const adjustsScroll = frame.panY !== 0 || resolved.zoom !== this.#zoom;
    if (resolved.zoom !== this.#zoom) {
      this.#applyZoomLayout({ blockSize: resolved.blockSize, zoom: resolved.zoom });
    }
    const previousCameraX = this.#cameraX;
    this.#zoom = resolved.zoom;
    this.#cameraX = resolved.cameraX;
    this.#setInput(
      reduceInput(this.#getInput(), {
        type: "configure",
        fitZoom: resolved.fitZoom,
        zoom: this.#zoom,
      }).state,
    );
    this.#applyCamera({ x: this.#cameraX, zoom: this.#zoom });
    if (momentumDelta !== 0 && this.#cameraX === previousCameraX) {
      this.cancelPanMomentum();
    }
    if (adjustsScroll) browserScrollMetrics.setScrollTop(this.#scrollOwner, resolved.scrollTop);
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

  #hasPendingFrame(): boolean {
    return (
      this.#panMomentum.active ||
      Math.abs(this.#wheelState.pendingSteps) >= 1 ||
      zoomFrameHasPending(this.#frameState)
    );
  }

  #cancelPendingFrame(): void {
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#clearPendingFrame();
  }

  #clearPendingFrame(): void {
    this.#panMomentum.cancel();
    this.#wheelState = createWheelZoomState();
    this.#frameState = createZoomFrameState();
    this.#latestAnchor = undefined;
    this.#pendingLayout = undefined;
  }
}
