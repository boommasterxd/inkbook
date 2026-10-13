import type { SceneContentRenderer } from "./content-renderer";
import {
  SceneResourcePolicy,
  validateScrollPreloadMargin,
  visibilityPageBounds,
} from "./scene-resource-policy";
import { DEFAULT_SCROLL_PRELOAD_MARGIN_PX } from "../../domain/settings/types";
import type {
  MutableSceneInstrumentation,
  SceneElementRecord,
  SceneCamera,
  SceneRendererOptions,
  SceneStoreDelta,
  SceneViewport,
} from "./types";
import type { SceneVisibilityState } from "./visibility-state";
import type { SceneTransformPreviewController } from "./transform-preview-controller";
import type { SceneElementPreviews } from "./scene-element-previews";
import { sameViewport, validateViewport } from "./scene-runtime";
import type { ScenePreviewCommitController } from "./preview-commit-handoff";
import type { SceneLiveStrokeRenderer } from "./live-stroke-renderer";
import type { SceneLivePathCommits } from "./live-path-commits";
import type { SceneMotionController } from "./scene-motion-controller";
import type { Bounds } from "../../domain/geometry/primitives";
import type { SceneVisibilityPriority } from "./scene-entrant-priority";
import { NavigationPathPreparation } from "./navigation-path-preparation";
import type { ScenePathCache } from "./path-cache";
import { DocumentPathPreparation } from "./document-path-preparation";

interface NavigationPreparationOptions {
  readonly cache: ScenePathCache;
  readonly onPrepared: () => void;
  readonly scene: SceneRendererOptions;
}

export class SceneVisibilityCoordinator {
  readonly #content: SceneContentRenderer;
  readonly #resources: SceneResourcePolicy;
  readonly #visibility: SceneVisibilityState;
  readonly #transforms: SceneTransformPreviewController;
  readonly #elements: SceneElementPreviews;
  #dirty = true;
  #orderDirty = false;
  #queryPending = false;
  #initialVisibleOnly = false;
  #scrollPreloadMarginPx = DEFAULT_SCROLL_PRELOAD_MARGIN_PX;
  #preloadMarginDirty = false;
  #priorityViewport: Bounds | undefined;
  #priorityZoom: number | undefined;
  #priority: SceneVisibilityPriority | undefined;
  readonly #navigation: NavigationPathPreparation | undefined;
  readonly #documentPaths: DocumentPathPreparation | undefined;
  #documentPrewarmEnabled = true;
  #backgroundWait: Promise<void> | undefined;
  #released = false;
  #envelope: Bounds | undefined;
  #navigationHandle: number | undefined;

  public get initialVisibleOnly(): boolean {
    return this.#initialVisibleOnly;
  }

  public setInitialVisibleOnly(active: boolean): void {
    if (active === this.#initialVisibleOnly) return;
    this.#initialVisibleOnly = active;
    this.invalidate();
  }

  public setScrollPreloadMarginPx(value: number): boolean {
    validateScrollPreloadMargin(value);
    if (value === this.#scrollPreloadMarginPx) return false;
    this.#scrollPreloadMarginPx = value;
    this.#preloadMarginDirty = true;
    this.invalidate();
    return true;
  }

  public get hasPendingQuery(): boolean {
    return this.#queryPending;
  }

  public constructor(
    content: SceneContentRenderer,
    visibility: SceneVisibilityState,
    resources: SceneResourcePolicy,
    transforms: SceneTransformPreviewController,
    elements: SceneElementPreviews,
    private readonly navigationOptions?: NavigationPreparationOptions,
  ) {
    this.#content = content;
    this.#visibility = visibility;
    this.#resources = resources;
    this.#transforms = transforms;
    this.#elements = elements;
    if (navigationOptions !== undefined) {
      this.#documentPaths = new DocumentPathPreparation(
        navigationOptions.scene.store,
        navigationOptions.cache,
        () => this.scheduleNavigationFrame(),
      );
      this.#navigation = new NavigationPathPreparation(
        navigationOptions.scene.store,
        navigationOptions.cache,
        () => this.scheduleNavigationFrame(),
        () => {
          if (this.#content.hasPendingWork) navigationOptions.onPrepared();
        },
      );
      this.setScrollPreloadMarginPx(
        navigationOptions.scene.scrollPreloadMarginPx ?? DEFAULT_SCROLL_PRELOAD_MARGIN_PX,
      );
      this.setInitialVisibleOnly(navigationOptions.scene.deferInitialOverscan ?? false);
    }
  }

  public previewMemoryUsage(): number {
    return (
      this.#elements.memoryUsage() +
      this.#transforms.memoryUsage() +
      this.#visibility.queryMemoryUsage() +
      (this.#navigationHandle === undefined ? 0 : 128) +
      (this.#backgroundWait === undefined ? 0 : 128) +
      (this.#documentPaths?.memoryUsage() ?? 0) +
      (this.#navigation?.memoryUsage() ?? 0)
    );
  }

  public release(): void {
    this.#released = true;
    this.cancelNavigationPreparation();
    this.#documentPaths?.release();
    this.#backgroundWait = undefined;
    this.#visibility.release();
  }

  public applyDelta(delta: SceneStoreDelta): void {
    this.#documentPaths?.invalidate(delta);
  }

  public takePreparedPath(record: SceneElementRecord) {
    return this.#documentPaths?.takeReady(record);
  }

  public setDocumentPrewarmEnabled(enabled: boolean): void {
    if (enabled === this.#documentPrewarmEnabled) return;
    this.#documentPrewarmEnabled = enabled;
    if (enabled) {
      if (this.#documentPaths?.needsWork === true) this.scheduleNavigationFrame();
    } else {
      this.#documentPaths?.pause();
      if (this.#navigation?.hasPendingPreparation !== true) this.cancelNavigationFrame();
    }
  }

  public setActiveDocumentMemoryPressure(active: boolean): void {
    if (active) this.cancelNavigationPreparation();
    else if (this.#documentPaths?.needsWork === true) this.scheduleNavigationFrame();
  }

  public cancelNavigationPreparation(): void {
    this.cancelNavigationFrame();
    this.#navigation?.cancel();
    this.#documentPaths?.pause();
  }

  /** Required camera work keeps useful directional preparation for the next target. */
  public invalidate(preservePending = false): void {
    this.#dirty = true;
    this.#documentPaths?.pause();
    this.cancelNavigationFrame();
    if (!preservePending) {
      this.#navigation?.cancel();
      this.#content.cancelPendingVisibility();
    }
  }

  public invalidateOrder(): void {
    this.#documentPaths?.pause();
    this.cancelNavigationFrame();
    this.#orderDirty = true;
    this.#visibility.invalidateStagedOrder();
  }

  public releasePreviews(): void {
    this.invalidate();
    this.#content.replaceVisibility(this.#visibility.resortCurrent(), !this.#orderDirty);
  }

  public releaseCommittedPreview(commits: ScenePreviewCommitController): void {
    if (!commits.releaseCommitted()) return;
    this.#elements.retainCommittedGeometry(this.#transforms.values);
    this.#transforms.clear();
    this.#elements.clear();
    this.releasePreviews();
  }

  public finishMountedFrame(
    liveStroke: SceneLiveStrokeRenderer,
    livePaths: SceneLivePathCommits,
    motion: SceneMotionController,
    frameTime: number,
  ): void {
    this.#elements.applyMounted(this.#content.takeCommittedPreviewIds());
    const settled = (id: string) =>
      this.#content.hasMounted(id) || (!this.#queryPending && !this.#visibility.contains(id));
    liveStroke.settleCommits(settled);
    livePaths.settle(settled);
    const mountedIds = this.#content.takeNewlyMountedIds();
    this.#transforms.applyMounted(mountedIds);
    motion.bindMountedEntrances(mountedIds, frameTime);
    motion.finishEntranceBatch();
    this.#elements.applyMounted(mountedIds);
    this.prepareNavigation();
  }

  public releaseLostPreviews(
    ...args: Parameters<SceneContentRenderer["hasUnprotectedDeferredExit"]>
  ): void {
    if (this.#content.hasUnprotectedDeferredExit(...args)) this.releasePreviews();
  }

  public readViewport(
    layout: SceneRendererOptions["layout"],
    previous: SceneViewport | undefined,
    camera: SceneCamera,
    instrumentation: MutableSceneInstrumentation,
  ): SceneViewport {
    const viewport = layout.readViewport();
    instrumentation.layoutReads += 1;
    validateViewport(viewport);
    if (!sameViewport(previous, viewport)) this.setContext(camera, viewport);
    return viewport;
  }

  public setContext(camera: SceneCamera, viewport: SceneViewport | undefined): void {
    this.#content.setMembershipViewport(
      viewport === undefined ? undefined : visibilityPageBounds(viewport, camera, true).envelope,
    );
    const envelope =
      viewport === undefined ? undefined : visibilityPageBounds(viewport, camera).envelope;
    this.#transforms.setContext(camera, viewport, envelope);
    this.#elements.refreshProgressiveContext(viewport, camera, envelope);
    this.invalidate(true);
  }

  public prepare(
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
    deadline = Infinity,
    now: () => number = () => this.navigationOptions?.scene.workScheduler.now() ?? 0,
  ): void {
    if (viewport === undefined) return;
    this.setPriority(viewport, camera);
    if (!this.#dirty) {
      if (this.#orderDirty) {
        this.#orderDirty = false;
        const visibility = this.#visibility.resortCurrent();
        this.#content.replaceVisibility(visibility);
        this.#resources.updateVisibility(visibility);
      }
      if (this.#content.hasPendingWork) this.prepareNavigation();
      return;
    }
    const { envelope, retained } = visibilityPageBounds(
      viewport,
      camera,
      this.#initialVisibleOnly,
      this.#scrollPreloadMarginPx,
      this.#priority?.direction,
    );
    this.#envelope = envelope;
    this.#navigation?.setTarget(this.#priority, envelope);
    const orderDirty = this.#orderDirty;
    const progressive = !orderDirty;
    this.#dirty = false;
    this.#orderDirty = false;
    const result = this.#visibility.query(
      envelope,
      retained,
      !orderDirty && !this.#content.needsVisibilityRestart,
      deadline,
      now,
      this.#preloadMarginDirty,
    );
    this.#queryPending = result.pending === true;
    if (this.#queryPending) {
      this.#dirty = true;
      this.#orderDirty ||= orderDirty;
      return;
    }
    this.#preloadMarginDirty = false;
    this.#transforms.setContext(camera, viewport, envelope);
    this.#elements.refreshProgressiveContext(viewport, camera, envelope, true);
    this.#content.settleMembershipVisibility((id) => this.#visibility.contains(id));
    if (!result.changed && !orderDirty && !this.#content.needsVisibilityRestart) {
      if (this.#content.hasPendingWork) this.prepareNavigation();
      return;
    }
    const visibility =
      !result.changed && orderDirty ? this.#visibility.resortCurrent() : result.visibility;
    this.#content.replaceVisibility(visibility, progressive, result.delta);
    this.#resources.updateVisibility(visibility);
  }

  private prepareNavigation(): void {
    const options = this.navigationOptions;
    if (options === undefined || this.#envelope === undefined) return;
    if (
      options.scene.isInputActive?.() === true ||
      !this.#resources.allowsNavigationPreparation ||
      this.#initialVisibleOnly
    ) {
      this.cancelNavigationFrame();
      this.#navigation!.cancel();
      this.#documentPaths?.pause();
      this.waitForQuiet();
      return;
    }
    if (
      this.#dirty ||
      this.#orderDirty ||
      this.#queryPending ||
      this.#content.hasPendingViewportWork ||
      this.#elements.progressive.pending ||
      this.#transforms.values.size > 0 ||
      this.#elements.values.size > 0
    ) {
      this.cancelNavigationFrame();
      this.#documentPaths?.pause();
      const scheduler = options.scene.workScheduler;
      if (
        this.#navigation!.hasReadyPaths &&
        this.#navigation!.adoptReady(scheduler.deadline(), () => scheduler.now())
      )
        this.scheduleNavigationFrame();
      return;
    }
    if (this.waitForQuiet()) {
      this.cancelNavigationFrame();
      this.#navigation!.pause();
      return;
    }
    this.#navigation!.setTarget(this.#priority, this.#envelope);
    const scheduler = options.scene.workScheduler;
    if (this.#navigation!.prepare(scheduler.deadline(), () => scheduler.now()))
      this.scheduleNavigationFrame();
    this.prepareDocumentPaths();
  }

  private prepareDocumentPaths(): void {
    const documentPaths = this.#documentPaths!;
    if (
      !this.#documentPrewarmEnabled ||
      !documentPaths.needsWork ||
      this.#content.hasPendingWork ||
      this.#navigation!.hasPendingPreparation
    )
      return;
    if (this.waitForQuiet()) return;
    const scheduler = this.navigationOptions!.scene.workScheduler;
    if (documentPaths.prepare(scheduler.deadline(), () => scheduler.now()))
      this.scheduleNavigationFrame();
  }

  private waitForQuiet(): boolean {
    if (this.#backgroundWait !== undefined) return true;
    const wait = this.navigationOptions?.scene.waitForBackground?.();
    if (wait === undefined) return false;
    this.#documentPaths?.pause();
    this.#backgroundWait = wait;
    void wait.then(
      () => {
        if (this.#released || this.#backgroundWait !== wait) return;
        this.#backgroundWait = undefined;
        this.scheduleNavigationFrame();
      },
      () => {
        if (this.#backgroundWait === wait) this.#backgroundWait = undefined;
      },
    );
    return true;
  }

  private scheduleNavigationFrame(): void {
    if (
      this.#released ||
      this.#navigationHandle !== undefined ||
      (!this.#documentPrewarmEnabled && this.#navigation?.hasPendingPreparation !== true)
    )
      return;
    this.#navigationHandle = this.navigationOptions!.scene.workScheduler.requestFrame(() => {
      this.#navigationHandle = undefined;
      this.prepareNavigation();
      this.#resources.notifyUsageChanged();
    }, "background");
  }

  private cancelNavigationFrame(): void {
    if (this.#navigationHandle === undefined) return;
    this.navigationOptions!.scene.workScheduler.cancelFrame(this.#navigationHandle);
    this.#navigationHandle = undefined;
  }

  private setPriority(viewport: SceneViewport, camera: SceneCamera): void {
    const bounds = visibilityPageBounds(viewport, camera, true).envelope;
    const previous = this.#priorityViewport;
    const zoomChanged = this.#priorityZoom !== camera.zoom;
    if (
      !zoomChanged &&
      previous?.minX === bounds.minX &&
      previous.minY === bounds.minY &&
      previous.maxX === bounds.maxX &&
      previous.maxY === bounds.maxY
    )
      return;
    // Host scrolling can move only one clip edge while the other stays at the page boundary.
    const x =
      previous === undefined || zoomChanged
        ? 0
        : bounds.minX + bounds.maxX - previous.minX - previous.maxX;
    const y =
      previous === undefined || zoomChanged
        ? 0
        : bounds.minY + bounds.maxY - previous.minY - previous.maxY;
    const length = Math.hypot(x, y);
    this.#priority = {
      viewport: bounds,
      direction: { x: length === 0 ? 0 : x / length, y: length === 0 ? 0 : y / length },
    };
    this.#content.setVisibilityPriority(this.#priority);
    this.#priorityViewport = bounds;
    this.#priorityZoom = camera.zoom;
  }
}
