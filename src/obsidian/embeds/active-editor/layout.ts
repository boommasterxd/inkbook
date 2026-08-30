import { alignPageHeightToWritingLine, PAGE_WIDTH } from "../../../domain/geometry/public";
import type { PageV1 } from "../../../domain/schema/public";
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
import { ActivePageLayout, type PageHeightUpdate } from "./page-layout";
import { measureToolbarLayout } from "./toolbar-measurement";
import { ActiveEditorMotion, type ActiveEditorMotionPreference } from "./layout-motion";
import { measureElementBox } from "./element-content-box";
import { ActiveHeightTransition } from "./height-transition";

export type { ActiveEditorResizeAnchor, ActiveEditorResizeUpdate } from "./layout-resize";
export type { ActiveEditorLayoutOptions } from "./layout-contracts";

interface HeightFrameRead {
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
  readonly #heightTransition: ActiveHeightTransition;
  #chromeMounted = false;
  #fitZoom: number | undefined;
  #forcePageHeight = false;
  #frame: number | undefined;
  #layoutStage: ToolbarLayoutStage | undefined;
  #previewPage: PageV1 | undefined;
  #chromeLayoutKey: string | undefined;
  #ready = false;
  #readyFrame: number | undefined;
  #stableWidth: StableWidthState = createStableWidthState();
  #suspended = false;
  #toolbar: HTMLElement | undefined;
  #toolbarLayoutDirty = true;
  #zoom: number | undefined;

  public constructor(options: ActiveEditorLayoutOptions) {
    this.#options = options;
    this.#container = options.container;
    const ownerWindow = options.root.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The active editor requires an owning window.");
    this.#ownerWindow = ownerWindow;
    this.#heightTransition = new ActiveHeightTransition(
      this.#container,
      ownerWindow,
      options.beginScrollStability,
    );
    this.#motion = new ActiveEditorMotion(
      ownerWindow,
      motionPreference(options.root.dataset?.inkbookMotion),
      () => this.#completeHeightTransitionImmediately(),
    );
    const observerConstructor = ownerWindow.ResizeObserver;
    this.#observer =
      observerConstructor === undefined
        ? undefined
        : new observerConstructor(() => {
            this.#toolbarLayoutDirty = true;
            this.#options.renderer.invalidateLayout();
            this.scheduleMeasurement();
          });
    this.#observer?.observe(options.root);
    const chromeObserverConstructor = ownerWindow.MutationObserver;
    this.#chromeObserver =
      chromeObserverConstructor === undefined
        ? undefined
        : new chromeObserverConstructor(() => this.#handleChromeMutation());
    this.#chromeObserver?.observe(options.chromeHost, {
      attributeFilter: ["data-presence"],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  public applyZoom(update: ActiveEditorZoomLayoutUpdate): void {
    const retainedPageHeight = this.#cancelHeightTransitionAtBoundary(false);
    this.#zoom = update.zoom;
    const blockSize =
      retainedPageHeight === undefined ? update.blockSize : retainedPageHeight * update.zoom;
    this.#container.style.blockSize = `${String(blockSize)}px`;
    this.#options.renderer.invalidateLayout();
    if (retainedPageHeight !== undefined) this.scheduleMeasurement();
  }

  public chromeChanged(layoutKey?: string): void {
    if (layoutKey !== undefined && layoutKey === this.#chromeLayoutKey) return;
    this.#chromeLayoutKey = layoutKey;
    this.#toolbarLayoutDirty = true;
    this.scheduleMeasurement();
  }

  public chromeMounted(): void {
    if (this.#chromeMounted) return;
    this.#chromeMounted = true;
    this.#observeToolbar();
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
    this.#heightTransition.cancel();
    this.#frame = undefined;
    this.#readyFrame = undefined;
  }

  public finishPagePreview(committed: boolean): void {
    if (this.#previewPage === undefined) return;
    this.#previewPage = undefined;
    if (committed) return;
    this.#cancelHeightTransitionAtBoundary(false);
    this.#applyPreviewHeight(this.#options.page());
  }

  public interruptForInput(): void {
    if (this.#cancelHeightTransitionAtBoundary(true) !== undefined) this.scheduleMeasurement();
  }

  public pageChanged(): void {
    this.#forcePageHeight = true;
    const preparationHeight = this.#scenePreparationHeight();
    if (preparationHeight !== undefined) {
      this.#options.renderer.setPage(this.#options.page(), preparationHeight);
    }
    this.scheduleMeasurement();
  }

  public previewPage(page: PageV1): void {
    this.#cancelHeightTransitionAtBoundary(false);
    this.#previewPage = page;
    this.#applyPreviewHeight(page);
  }

  #applyPreviewHeight(page: PageV1): void {
    const update = this.#pageLayout.committed(page, this.#options.storeMaximumBottom(), true);
    if (update === undefined) {
      const height = this.#scenePreparationHeight();
      if (height === undefined) this.#options.renderer.setPage(page);
      else this.#options.renderer.setPage(page, height);
      return;
    }
    this.#applyHeightUpdate(update, page);
  }

  public resume(): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    this.scheduleMeasurement();
  }

  public suspend(): void {
    if (this.#suspended) return;
    this.#cancelHeightTransitionAtBoundary(true);
    this.#suspended = true;
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    if (this.#readyFrame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#readyFrame);
    this.#frame = undefined;
    this.#readyFrame = undefined;
  }

  public updateMotion(preference: ActiveEditorMotionPreference): void {
    this.#motion.update(preference);
  }

  public sceneCommitted(): void {
    this.#heightTransition.sceneCommitted();
  }

  private scheduleMeasurement(): void {
    if (this.#suspended || !this.#chromeMounted || this.#frame !== undefined) return;
    this.#frame = this.#ownerWindow.requestAnimationFrame(() => {
      this.#frame = undefined;
      if (this.#suspended) return;
      this.measure();
    });
  }

  #handleChromeMutation(): void {
    this.#toolbarLayoutDirty = true;
    this.#observeToolbar();
    this.scheduleMeasurement();
  }

  #observeToolbar(): void {
    const toolbar = this.#options.chromeHost.querySelector<HTMLElement>(".inkbook-toolbar");
    if (toolbar === null || toolbar === this.#toolbar) return;
    if (this.#toolbar !== undefined) this.#observer?.unobserve(this.#toolbar);
    this.#toolbar = toolbar;
    this.#toolbarLayoutDirty = true;
    this.#observer?.observe(toolbar);
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
    this.#options.onLayout(this.#resolveLayoutAndSchedule(width, widthChanged));
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

  #applyHeightUpdate(update: PageHeightUpdate | undefined, page = this.#renderPage()): void {
    if (update === undefined) return;
    const zoom = this.#zoom;
    const frameRead = zoom === undefined ? undefined : this.#readHeightFrame();
    if (zoom === undefined) {
      this.#options.renderer.setPage(page, update.height);
      return;
    }
    if (!update.animate) {
      this.#heightTransition.cancel();
      this.#options.renderer.setPage(page, update.height);
      this.#writeHeightFrame(update.height, zoom);
      this.#completeHeightTransition();
      return;
    }
    const currentRenderedHeight = frameRead?.renderedHeight ?? update.height * zoom;
    const targetRenderedHeight = update.height * zoom;
    const currentPageHeight = currentRenderedHeight / zoom;
    const preparationHeight = alignPageHeightToWritingLine(
      page,
      Math.max(update.height, currentPageHeight),
    );
    this.#options.renderer.setPage(page, preparationHeight);
    this.#heightTransition.begin({
      applyFrame: (renderedHeight) => this.#writeHeightFrame(renderedHeight / zoom, zoom),
      applySurfaceTarget: () => this.#options.renderer.setPage(this.#renderPage(), update.height),
      currentRenderedHeight,
      onComplete: () => this.#completeHeightTransition(),
      sceneCommitPending: () => this.#options.renderer.hasPendingSceneCommit,
      targetRenderedHeight,
    });
    if (this.#motion.reduced) this.#heightTransition.finishImmediately();
  }

  #scenePreparationHeight(): number | undefined {
    const height = this.#pageLayout.height;
    const settledHeight = this.#pageLayout.settledHeight;
    if (height === undefined) return settledHeight;
    if (settledHeight === undefined) return height;
    return Math.max(height, settledHeight);
  }

  #completeHeightTransition(): void {
    const next = this.#pageLayout.transitionCompleted();
    this.#applyHeightUpdate(next);
  }

  #completeHeightTransitionImmediately(): void {
    this.#heightTransition.finishImmediately();
  }

  #cancelHeightTransitionAtBoundary(applyFrame: boolean): number | undefined {
    const cancelled = this.#heightTransition.cancelAtCurrent();
    const zoom = this.#zoom;
    if (cancelled === undefined || zoom === undefined || zoom <= 0) return undefined;
    const currentPageHeight = cancelled.renderedHeight / zoom;
    const completed = cancelled.settleToTarget ? this.#pageLayout.completeTransitions() : undefined;
    const pageHeight = completed?.height ?? currentPageHeight;
    if (completed === undefined) this.#pageLayout.cancelTransitions(pageHeight);
    this.#options.renderer.setPage(this.#renderPage(), pageHeight);
    if (applyFrame && completed !== undefined) {
      this.#writeHeightFrame(pageHeight, zoom);
    }
    return pageHeight;
  }

  #renderPage(): PageV1 {
    return this.#previewPage ?? this.#options.page();
  }

  #writeBlockSize(pageHeight: number | undefined, zoom: number): void {
    if (pageHeight !== undefined) {
      this.#container.style.blockSize = `${String(pageHeight * zoom)}px`;
    }
    this.#options.renderer.invalidateLayout();
  }

  #readHeightFrame(): HeightFrameRead | undefined {
    const renderedHeight = Math.max(0, this.#container.getBoundingClientRect().height);
    if (!Number.isFinite(renderedHeight)) return undefined;
    return { renderedHeight };
  }

  #writeHeightFrame(pageHeight: number, zoom: number): void {
    const renderedHeight = pageHeight * zoom;
    this.#container.style.blockSize = `${String(renderedHeight)}px`;
    this.#options.renderer.invalidateLayout();
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

  #resolveLayoutAndSchedule(availableWidth: number, widthChanged: boolean): ToolbarLayoutStage {
    if (!widthChanged && !this.#toolbarLayoutDirty && this.#layoutStage !== undefined) {
      return this.#layoutStage;
    }
    this.#toolbarLayoutDirty = false;
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
}

function motionPreference(value: string | undefined): ActiveEditorMotionPreference {
  return value === "full" || value === "reduced" || value === "system" ? value : "system";
}
