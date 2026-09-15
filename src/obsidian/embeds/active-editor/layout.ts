import {
  alignPageHeightToWritingLine,
  derivePageExtent,
  PAGE_WIDTH,
} from "../../../domain/geometry/public";
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
import { ToolbarResizeObservation } from "./toolbar-resize-observation";
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
  #blockInsets = 0;
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
  #selectionMoveActive = false;
  #toolbar: HTMLElement | undefined;
  #toolbarLayoutDirty = true;
  readonly #resizeObservation = new ToolbarResizeObservation();
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
        : new observerConstructor((entries) => {
            this.#options.renderer.invalidateLayout();
            if (!this.#resizeObservation.affectsToolbar(entries, options.root)) return;
            this.#toolbarLayoutDirty = true;
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
    this.#retainCommittedExtent();
    this.#zoom = update.zoom;
    const blockSize =
      retainedPageHeight === undefined ? update.blockSize : retainedPageHeight * update.zoom;
    this.#container.style.blockSize = `${String(blockSize + this.#blockInsets)}px`;
    this.#options.renderer.invalidateLayout();
    if (retainedPageHeight !== undefined) this.scheduleMeasurement();
  }

  public chromeChanged(layoutKey?: string): void {
    if (layoutKey !== undefined && layoutKey === this.#chromeLayoutKey) return;
    this.#chromeLayoutKey = layoutKey;
    this.#toolbarLayoutDirty = true;
    this.scheduleMeasurement();
  }

  public beginSelectionMove(): void {
    this.#selectionMoveActive = true;
    this.#applyHeightUpdate(this.#pageLayout.beginSelectionMove());
  }

  public currentPageHeight(): number | undefined {
    return this.#pageLayout.height;
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

  public finishSelectionMove(committed: boolean, previewMaximumBottom?: number): void {
    this.#selectionMoveActive = false;
    const storeMaximumBottom = this.#options.storeMaximumBottom();
    const maximumBottom = committed
      ? maximumFiniteBottom(storeMaximumBottom, previewMaximumBottom)
      : storeMaximumBottom;
    this.#applyHeightUpdate(
      this.#pageLayout.finishSelectionMove(committed, this.#options.page(), maximumBottom),
    );
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

  public updateSelectionMoveBottom(maximumBottom: number): void {
    this.#applyHeightUpdate(
      this.#pageLayout.previewSelectionMove(this.#options.page(), maximumBottom),
    );
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
    const measurement = measureElementBox(this.#container);
    this.#blockInsets = measurement.blockInsets;
    const measuredWidth = measurement.contentBox.width;
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
    this.#container.style.blockSize = `${String(resized.renderedContainerHeight + this.#blockInsets)}px`;
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
    const minimumHeight = this.#requiredContentHeight(page);
    this.#pageLayout.retainMinimumHeight(minimumHeight);
    const targetHeight = Math.max(update.height, minimumHeight);
    const zoom = this.#zoom;
    const frameRead = zoom === undefined ? undefined : this.#readHeightFrame();
    if (zoom === undefined) {
      this.#options.renderer.setPage(page, targetHeight);
      return;
    }
    if (!update.animate) {
      this.#heightTransition.cancel();
      this.#options.renderer.setPage(page, targetHeight);
      this.#writeHeightFrame(targetHeight, zoom);
      this.#completeHeightTransition();
      return;
    }
    const currentRenderedHeight =
      frameRead?.renderedHeight ?? targetHeight * zoom + this.#blockInsets;
    const targetRenderedHeight = targetHeight * zoom + this.#blockInsets;
    const currentPageHeight = (currentRenderedHeight - this.#blockInsets) / zoom;
    const preparationHeight = alignPageHeightToWritingLine(
      page,
      Math.max(targetHeight, currentPageHeight),
    );
    this.#options.renderer.setPage(page, preparationHeight);
    this.#heightTransition.begin({
      applyFrame: (renderedHeight) =>
        this.#writeHeightFrame((renderedHeight - this.#blockInsets) / zoom, zoom),
      applySurfaceTarget: () =>
        this.#options.renderer.setPage(
          this.#renderPage(),
          Math.max(targetHeight, this.#requiredContentHeight()),
        ),
      currentRenderedHeight,
      onComplete: () => this.#completeHeightTransition(),
      sceneCommitPending: () => this.#options.renderer.hasPendingSceneCommit,
      stabilizeScroll: !this.#selectionMoveActive,
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
    const currentPageHeight = (cancelled.renderedHeight - this.#blockInsets) / zoom;
    const completed = cancelled.settleToTarget ? this.#pageLayout.completeTransitions() : undefined;
    const committedHeight = deriveActiveHeight(
      this.#options.page(),
      this.#options.storeMaximumBottom(),
    );
    const safeHeight = Math.max(
      completed?.height ?? currentPageHeight,
      this.#pageLayout.height ?? 0,
      committedHeight,
    );
    const retainedHeight = completed?.height ?? currentPageHeight;
    if (completed === undefined) this.#pageLayout.cancelTransitions(retainedHeight);
    this.#options.renderer.setPage(this.#renderPage(), safeHeight);
    if (applyFrame && completed !== undefined) {
      this.#writeHeightFrame(safeHeight, zoom);
    }
    return safeHeight;
  }

  #renderPage(): PageV1 {
    return this.#previewPage ?? this.#options.page();
  }

  #writeBlockSize(pageHeight: number | undefined, zoom: number): void {
    if (pageHeight !== undefined) {
      const safeHeight = Math.max(pageHeight, this.#requiredContentHeight());
      this.#container.style.blockSize = `${String(safeHeight * zoom + this.#blockInsets)}px`;
    }
    this.#options.renderer.invalidateLayout();
  }

  #readHeightFrame(): HeightFrameRead | undefined {
    const renderedHeight = Math.max(0, this.#container.getBoundingClientRect().height);
    if (!Number.isFinite(renderedHeight)) return undefined;
    return { renderedHeight };
  }

  #writeHeightFrame(pageHeight: number, zoom: number): void {
    const renderedHeight = pageHeight * zoom + this.#blockInsets;
    this.#container.style.blockSize = `${String(renderedHeight)}px`;
    this.#options.renderer.invalidateLayout();
  }

  #requiredContentHeight(page = this.#renderPage()): number {
    return deriveActiveHeight(page, this.#options.storeMaximumBottom());
  }

  #retainCommittedExtent(): void {
    this.#pageLayout.retainMinimumHeight(this.#requiredContentHeight());
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

function maximumFiniteBottom(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  const values = [first, second].filter((value): value is number => Number.isFinite(value));
  return values.length === 0 ? undefined : Math.max(...values);
}

function deriveActiveHeight(page: PageV1, maximumBottom: number | undefined): number {
  return derivePageExtent(page, maximumBottom ?? null).activeHeight;
}

function motionPreference(value: string | undefined): ActiveEditorMotionPreference {
  return value === "full" || value === "reduced" || value === "system" ? value : "system";
}
