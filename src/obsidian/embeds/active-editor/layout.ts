import { PAGE_WIDTH } from "../../../domain/geometry/public";
import type { PointV1 } from "../../../domain/schema/public";
import {
  calculateZoomLimits,
  createStableWidthState,
  observeStableWidth,
} from "../../../editor/zoom/index";
import type { StableWidthState } from "../../../editor/zoom/resize";
import type { ToolbarLayoutStage } from "../../../rendering/ui/index";
import type { ActiveEditorLayoutOptions } from "./layout-contracts";
import type { ActiveEditorZoomLayoutUpdate } from "./navigation";
import { calculateActiveEditorResize, type ActiveEditorResizeAnchor } from "./layout-resize";
import {
  ActivePageLayout,
  AUTOMATIC_PAGE_HEIGHT_TRANSITION_MS,
  SELECTION_BOTTOM_EDGE_ZONE_PX,
  type PageHeightUpdate,
} from "./page-layout";
import { measureToolbarLayout } from "./toolbar-measurement";
import { ActiveEditorMotion, type ActiveEditorMotionPreference } from "./layout-motion";
import { measureElementBox } from "./element-content-box";

export type { ActiveEditorResizeAnchor, ActiveEditorResizeUpdate } from "./layout-resize";
export type { ActiveEditorLayoutOptions } from "./layout-contracts";

interface HeightFrameRead {
  readonly anchor: ActiveEditorResizeAnchor;
  readonly fitZoom: number;
  readonly renderedHeight: number;
}

export class ActiveEditorLayout {
  readonly #chromeObserver: MutationObserver | undefined;
  readonly #container: HTMLElement;
  readonly #observer: ResizeObserver | undefined;
  readonly #options: ActiveEditorLayoutOptions;
  readonly #ownerWindow: Window;
  readonly #motion: ActiveEditorMotion;
  readonly #pageLayout = new ActivePageLayout();
  #chromeMounted = false;
  #fitZoom: number | undefined;
  #forcePageHeight = false;
  #frame: number | undefined;
  #heightTimer: number | undefined;
  #layoutStage: ToolbarLayoutStage | undefined;
  #ready = false;
  #readyFrame: number | undefined;
  #stableWidth: StableWidthState = createStableWidthState();
  #zoom: number | undefined;

  public constructor(options: ActiveEditorLayoutOptions) {
    this.#options = options;
    this.#container = options.container;
    const ownerWindow = options.root.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The active editor requires an owning window.");
    this.#ownerWindow = ownerWindow;
    this.#motion = new ActiveEditorMotion(
      ownerWindow,
      motionPreference(options.root.dataset?.inkbookMotion),
      () => this.#completeHeightTransitionImmediately(),
    );
    const Observer = ownerWindow.ResizeObserver;
    this.#observer =
      Observer === undefined ? undefined : new Observer(() => this.scheduleMeasurement());
    this.#observer?.observe(options.root);
    const ChromeObserver = ownerWindow.MutationObserver;
    this.#chromeObserver =
      ChromeObserver === undefined
        ? undefined
        : new ChromeObserver(() => this.scheduleMeasurement());
    this.#chromeObserver?.observe(options.chromeHost, {
      attributeFilter: ["data-presence"],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  public applyZoom(update: ActiveEditorZoomLayoutUpdate): void {
    this.#completeHeightTransitionImmediately();
    this.#zoom = update.zoom;
    this.#container.style.blockSize = `${String(update.blockSize)}px`;
    this.#options.renderer.invalidateLayout();
  }

  public beginSelectionEdgeDrag(): void {
    this.#applyHeightUpdate(this.#pageLayout.beginSelection());
  }

  public chromeChanged(): void {
    this.scheduleMeasurement();
  }

  public chromeMounted(): void {
    if (this.#chromeMounted) return;
    this.#chromeMounted = true;
    this.scheduleMeasurement();
  }

  public contentChanged(): void {
    this.scheduleMeasurement();
  }

  public dispose(): void {
    this.#chromeObserver?.disconnect();
    this.#observer?.disconnect();
    this.#motion.dispose();
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    if (this.#readyFrame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#readyFrame);
    this.#clearHeightTimer();
    this.#frame = undefined;
    this.#readyFrame = undefined;
  }

  public finishSelectionEdgeDrag(outcome: "cancel" | "commit"): void {
    const update = this.#pageLayout.finishSelection(
      outcome,
      this.#options.page(),
      this.#options.storeMaximumBottom(),
    );
    this.#applyHeightUpdate(update);
  }

  public interruptForInput(): void {
    this.#completeHeightTransitionImmediately();
  }

  public pageChanged(): void {
    this.#forcePageHeight = true;
    this.scheduleMeasurement();
  }

  public setSelectionBottomEdge(active: boolean): void {
    this.#applyHeightUpdate(
      this.#pageLayout.updateSelectionBottomEdge(active, this.#options.page()),
    );
  }

  public updateMotion(preference: ActiveEditorMotionPreference): void {
    this.#motion.update(preference);
  }

  public updateSelectionEdgeDrag(screenPointer: PointV1): void {
    const bottom = this.#container.getBoundingClientRect().bottom;
    const active =
      Number.isFinite(screenPointer.y) && screenPointer.y >= bottom - SELECTION_BOTTOM_EDGE_ZONE_PX;
    this.setSelectionBottomEdge(active);
  }

  private scheduleMeasurement(): void {
    if (!this.#chromeMounted || this.#frame !== undefined) return;
    this.#frame = this.#ownerWindow.requestAnimationFrame(() => {
      this.#frame = undefined;
      this.measure();
    });
  }

  private measure(): void {
    const measuredWidth = measureElementBox(this.#container).contentBox.width;
    const reduction = observeStableWidth(this.#stableWidth, measuredWidth);
    this.#stableWidth = reduction.state;
    const acceptedWidth = this.#stableWidth.acceptedWidth;
    if (acceptedWidth === undefined || acceptedWidth !== measuredWidth) {
      if (Number.isFinite(measuredWidth) && measuredWidth > 0) this.scheduleMeasurement();
      return;
    }
    this.#measureStableLayout(acceptedWidth, reduction.observation !== undefined);
  }

  #measureStableLayout(width: number, widthChanged: boolean): void {
    const page = this.#options.page();
    const heightUpdate = this.#pageLayout.committed(
      page,
      this.#options.storeMaximumBottom(),
      this.#forcePageHeight,
    );
    this.#forcePageHeight = false;
    this.#applyHeightUpdate(heightUpdate);
    const fitZoom = width / PAGE_WIDTH;
    if (widthChanged || this.#fitZoom === undefined) this.#applyWidth(width, fitZoom);
    this.#options.onLayout(this.#resolveLayoutAndSchedule(width));
    this.#markReady();
  }

  #applyWidth(width: number, fitZoom: number): void {
    const previousFitZoom = this.#fitZoom;
    const previousZoom = this.#zoom;
    const pageHeight = this.#pageLayout.height;
    if (previousFitZoom !== undefined && previousZoom !== undefined && pageHeight !== undefined) {
      const anchor = this.#options.readResizeAnchor?.();
      if (anchor !== undefined && this.#options.onResize !== undefined) {
        this.#applyAnchoredResize(
          width,
          fitZoom,
          previousFitZoom,
          previousZoom,
          pageHeight,
          anchor,
        );
        return;
      }
    }
    const zoom = this.#resolvedZoom(fitZoom);
    this.#writeBlockSize(pageHeight, zoom);
    this.#options.renderer.setCamera({ x: 0, zoom });
    this.#options.onZoom(zoom);
    this.#fitZoom = fitZoom;
    this.#zoom = zoom;
  }

  #applyAnchoredResize(
    width: number,
    fitZoom: number,
    oldFitZoom: number,
    oldZoom: number,
    pageHeight: number,
    anchor: ActiveEditorResizeAnchor,
  ): void {
    const resized = calculateActiveEditorResize({
      anchor,
      fitZoom,
      oldFitZoom,
      oldZoom,
      pageHeight,
      width,
    });
    this.#container.style.blockSize = `${String(resized.renderedContainerHeight)}px`;
    this.#options.onResize?.({
      cameraX: resized.cameraX,
      fitZoom: resized.fitZoom,
      scrollTop: resized.scrollTop,
      zoom: resized.zoom,
    });
    this.#fitZoom = fitZoom;
    this.#zoom = resized.zoom;
    this.#options.renderer.invalidateLayout();
  }

  #applyHeightUpdate(update: PageHeightUpdate | undefined): void {
    if (update === undefined) return;
    const zoom = this.#zoom;
    const frameRead = zoom === undefined ? undefined : this.#readHeightFrame();
    this.#options.renderer.setPage(this.#options.page(), update.height);
    if (zoom === undefined) return;
    if (!update.animate || this.#motion.reduced) {
      this.#clearHeightTimer();
      this.#setTransition("none");
      this.#writeHeightFrame(update.height, zoom, frameRead);
      this.#completeHeightTransition(false);
      return;
    }
    this.#setTransition("block-size 180ms cubic-bezier(0.2, 0, 0, 1)");
    this.#writeHeightFrame(update.height, zoom, frameRead);
    this.#heightTimer = this.#setTimeout(
      () => this.#completeHeightTransition(),
      AUTOMATIC_PAGE_HEIGHT_TRANSITION_MS,
    );
    if (this.#heightTimer === undefined) this.#completeHeightTransition(false);
  }

  #completeHeightTransition(continueSelectionExtension = true): void {
    this.#clearHeightTimer();
    this.#setTransition("");
    const next = this.#pageLayout.transitionCompleted(
      this.#options.page(),
      continueSelectionExtension,
    );
    this.#applyHeightUpdate(next);
  }

  #completeHeightTransitionImmediately(): void {
    if (this.#heightTimer === undefined) return;
    this.#clearHeightTimer();
    this.#applyHeightUpdate(this.#pageLayout.completeTransitions());
  }

  #writeBlockSize(pageHeight: number | undefined, zoom: number): void {
    if (pageHeight !== undefined) {
      this.#container.style.blockSize = `${String(pageHeight * zoom)}px`;
    }
    this.#options.renderer.invalidateLayout();
  }

  #readHeightFrame(): HeightFrameRead | undefined {
    const fitZoom = this.#fitZoom;
    const anchor = this.#options.readResizeAnchor?.();
    if (fitZoom === undefined || anchor === undefined || this.#options.onResize === undefined) {
      return undefined;
    }
    return {
      anchor,
      fitZoom,
      renderedHeight: Math.max(0, this.#container.getBoundingClientRect().height),
    };
  }

  #writeHeightFrame(pageHeight: number, zoom: number, read: HeightFrameRead | undefined): void {
    const renderedHeight = pageHeight * zoom;
    this.#container.style.blockSize = `${String(renderedHeight)}px`;
    this.#options.renderer.invalidateLayout();
    if (read === undefined) return;
    const projectedMaximum = Math.max(
      read.anchor.scrollBounds.min,
      read.anchor.scrollBounds.max + renderedHeight - read.renderedHeight,
    );
    this.#options.onResize?.({
      cameraX: read.anchor.oldCameraX,
      fitZoom: read.fitZoom,
      scrollTop: Math.max(
        read.anchor.scrollBounds.min,
        Math.min(projectedMaximum, read.anchor.oldScrollTop),
      ),
      zoom,
    });
  }

  #resolvedZoom(fitZoom: number): number {
    if (this.#zoom === undefined || this.#fitZoom === undefined) return fitZoom;
    if (this.#fitZoom === fitZoom) return this.#zoom;
    const limits = calculateZoomLimits(fitZoom);
    return Math.max(
      limits.minZoom,
      Math.min(limits.maxZoom, (this.#zoom / this.#fitZoom) * fitZoom),
    );
  }

  #resolveLayoutAndSchedule(availableWidth: number): ToolbarLayoutStage {
    const stage = measureToolbarLayout(this.#options.chromeHost, availableWidth);
    if (stage !== this.#layoutStage) {
      this.#layoutStage = stage;
      this.scheduleMeasurement();
    }
    return stage;
  }

  #markReady(): void {
    if (this.#ready) return;
    this.#ready = true;
    this.#readyFrame = this.#ownerWindow.requestAnimationFrame(() => {
      this.#readyFrame = undefined;
      this.#options.onReady();
    });
  }

  #setTimeout(callback: () => void, delay: number): number | undefined {
    if (typeof this.#ownerWindow.setTimeout !== "function") return undefined;
    return this.#ownerWindow.setTimeout(callback, delay);
  }

  #clearHeightTimer(): void {
    if (this.#heightTimer === undefined) return;
    this.#ownerWindow.clearTimeout?.(this.#heightTimer);
    this.#heightTimer = undefined;
  }

  #setTransition(value: string): void {
    const style = this.#container.style as Partial<CSSStyleDeclaration>;
    if (value === "") style.removeProperty?.("transition");
    else style.setProperty?.("transition", value);
  }
}

function motionPreference(value: string | undefined): ActiveEditorMotionPreference {
  return value === "full" || value === "reduced" || value === "system" ? value : "system";
}
