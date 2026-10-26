import { SceneFrameScheduler } from "./scene-frame-scheduler";
import type { SceneToolCursorFrameReader } from "./tool-cursor";
import type { RenderBand } from "../../domain/commands/render-bands";
import type * as Schema from "../../domain/schema/public";
import { SceneBackgroundCache } from "./content/background-cache";
import { DetachedSceneElementCache } from "./content/detached-element-cache";
import { DEFAULT_CAMERA } from "./constants";
import { SceneContentRenderer } from "./content-renderer";
import type { ProgressivePreviewTransform } from "./presentation/progressive-element-preview";
import type { ProgressivePreviewPurpose } from "./presentation/connected-preview-cohort";
import { SceneElementPreviews } from "./presentation/scene-element-previews";
import { createFadeActions } from "./presentation/element-fade-controller";
import type { SceneElementFadeController } from "./presentation/element-fade-controller";
import { SceneFrameWriter } from "./scene-frame-writer";
import { SceneFrameWork } from "./scene-frame-work";
import * as stats from "./instrumentation";
import { ScenePathCache, type PreparedScenePath } from "./content/path-cache";
import type { PreviewCommitHandoff } from "./presentation/preview-commit-handoff";
import { ScenePreviewInput } from "./presentation/scene-preview-input";
import { SceneDom } from "./scene-dom";
import { SceneCommitCoordinator } from "./scene-commit-coordinator";
import { SceneContentScheduler } from "./scene-content-scheduler";
import { SceneDeltaCoordinator } from "./scene-delta-coordinator";
import { SceneLiveStrokeRenderer } from "./content/live-stroke-renderer";
import { SceneMotionController } from "./presentation/scene-motion-controller";
import { SceneResourcePolicy, validateScrollPreloadMargin } from "./scene-resource-policy";
import { SceneVisibilityCoordinator } from "./scene-visibility-coordinator";
import * as runtime from "./scene-runtime";
import type * as Scene from "./types";
import { SceneTransformPreviewController } from "./presentation/transform-preview-controller";
import { SceneVisibilityState } from "./visibility/visibility-state";
export class SvgSceneRenderer {
  #backgroundDirty = true;
  readonly #backgroundCache = new SceneBackgroundCache();
  #camera: Scene.SceneCamera = DEFAULT_CAMERA;
  readonly #content: SceneContentRenderer;
  readonly #contentScheduler: SceneContentScheduler;
  #disposed = false;
  readonly #dom: SceneDom;
  readonly #frameWriter: SceneFrameWriter;
  readonly #frameWork: SceneFrameWork;
  readonly #frames: SceneFrameScheduler;
  readonly #sceneCommits: SceneCommitCoordinator;
  readonly #deltas: SceneDeltaCoordinator;
  public readonly setElementFade: SceneElementFadeController["set"];
  public readonly clearElementFade: SceneElementFadeController["clear"];
  readonly #stats: Scene.MutableSceneInstrumentation = stats.createInstrumentation();
  #layoutDirty = true;
  #layoutInvalidationVersion = 0;
  readonly #liveStroke: SceneLiveStrokeRenderer;
  readonly #motion: SceneMotionController;
  #page: Schema.PageV1;
  #pageHeight = 1;
  readonly #previewInput: ScenePreviewInput;
  readonly #resourcePolicy: SceneResourcePolicy;
  readonly #pathCache = new ScenePathCache();
  readonly #detachedCache = new DetachedSceneElementCache();
  readonly #elementPreviews: SceneElementPreviews;
  readonly #transformPreviews: SceneTransformPreviewController;
  readonly #scheduler: Scene.SceneRendererOptions["workScheduler"];
  #viewport: Scene.SceneViewport | undefined;
  readonly #visibilityCoordinator: SceneVisibilityCoordinator;
  readonly #visibility: SceneVisibilityState;
  readonly #options: Scene.SceneRendererOptions;
  public constructor(options: Scene.SceneRendererOptions) {
    if (options.scrollPreloadMarginPx !== undefined)
      validateScrollPreloadMargin(options.scrollPreloadMarginPx);
    this.#options = options;
    this.#page = options.page;
    this.#scheduler = options.workScheduler;
    const render = this.renderFrame.bind(this);
    this.#frames = new SceneFrameScheduler(this.#scheduler, this.#stats, render);
    this.#dom = SceneDom.create(options);
    this.#dom.onSurfaceInvalidated = (themeChanged) =>
      themeChanged === true ? this.invalidateLayout() : this.#frames.schedule();
    this.#frameWriter = new SceneFrameWriter(this.#dom, this.#backgroundCache, this.#stats, () =>
      this.#content.refreshSelectionFeedbackZoom(),
    );
    this.#visibility = new SceneVisibilityState(options.store, this.#stats);
    this.#liveStroke = new SceneLiveStrokeRenderer(
      this.#dom.ownerDocument,
      this.#dom.liveStrokeGroup,
      (band) => this.#dom.placeLiveGroup("stroke", band),
      this.#stats,
    );
    this.#content = new SceneContentRenderer(
      this.#dom,
      options.store,
      this.#visibility,
      this.#pathCache,
      this.#stats,
      {
        detachedCache: this.#detachedCache,
        onPathsReady: () => this.#frames.schedule(),
        scheduler: this.#scheduler,
        zoom: () => this.#camera.zoom,
        takePreparedPath: (record) => this.#visibilityCoordinator.takePreparedPath(record),
      },
    );
    this.#contentScheduler = new SceneContentScheduler(this.#content, this.#scheduler);
    const { reducedMotion } = options;
    this.#motion = new SceneMotionController(this.#dom, this.#content, this.#stats, reducedMotion);
    this.#resourcePolicy = new SceneResourcePolicy(
      this.#pathCache,
      this.#motion,
      options.onResourceUsageChanged ?? (() => undefined),
      () => this.#visibilityCoordinator.previewMemoryUsage(),
      this.#detachedCache,
    );
    this.#elementPreviews = new SceneElementPreviews(this.#content, options.store);
    this.#transformPreviews = new SceneTransformPreviewController(this.#content, this.#camera);
    this.#visibilityCoordinator = new SceneVisibilityCoordinator(
      this.#content,
      this.#visibility,
      this.#resourcePolicy,
      this.#transformPreviews,
      this.#elementPreviews,
      {
        cache: this.#pathCache,
        onPrepared: () => this.#frames.schedule(),
        scene: options,
      },
    );
    this.#sceneCommits = new SceneCommitCoordinator(options.onSceneCommitted);
    this.#sceneCommits.markPending();
    this.#frameWork = new SceneFrameWork({
      backgroundPending: () => this.#backgroundDirty && this.#viewport !== undefined,
      queryPending: () => this.#visibilityCoordinator.hasPendingQuery,
      content: this.#content,
      contentScheduler: this.#contentScheduler,
      elements: this.#elementPreviews,
      motion: this.#motion,
      scheduler: this.#scheduler,
      writeBackground: (deadline, allowAtomic) => this.writeBackground(deadline, allowAtomic),
    });
    this.#previewInput = this.createPreviewInput();
    this.#deltas = new SceneDeltaCoordinator({
      commits: this.#sceneCommits,
      motion: this.#motion,
      previews: this.#previewInput.commits,
      routing: {
        content: this.#content,
        detachedCache: this.#detachedCache,
        invalidateVisibility: (reuse) => this.#visibilityCoordinator.invalidate(false, reuse),
        markOrderVisibilityDirty: () => this.#visibilityCoordinator.invalidateOrder(),
        pathCache: this.#pathCache,
        store: this.#options.store,
        visibility: this.#visibility,
      },
      schedule: () => this.#frames.schedule(),
    });
    [this.setElementFade, this.clearElementFade] = createFadeActions({
      assertActive: () => runtime.assertSceneActive(this.#disposed),
      content: this.#content,
      deltas: this.#deltas,
      motion: this.#motion,
      scheduler: this.#scheduler,
      schedule: () => this.#frames.schedule(),
    });
    this.#frames.schedule();
  }
  public get inputSurface(): HTMLDivElement {
    return this.#dom.inputSurface;
  }
  public get svg(): SVGSVGElement {
    return this.#dom.svg;
  }
  public readonly revealSurface = () => this.#dom.revealSurface();
  public readonly setZoomBlockSize = (value: number) => this.#dom.setZoomBlockSize(value);
  public get mountedCount(): number {
    return this.#content.mountedCount;
  }
  public applyDelta(delta: Scene.SceneStoreDelta): void {
    runtime.assertSceneActive(this.#disposed);
    if (this.#layoutDirty || this.#backgroundDirty || !this.#visibilityCoordinator.canReuseRemoval)
      this.#visibility.removalReuse.invalidate();
    this.#deltas.apply(delta, this.#visibilityCoordinator);
    this.#elementPreviews.applyMounted(this.#content.takeCommittedPreviewIds());
    this.#liveStroke.settleCommits((id) => this.#options.store.get(id) === undefined);
    this.#frameWriter.livePathCommits.settle((id) => this.#options.store.get(id) === undefined);
  }
  public get hasPendingSceneCommit(): boolean {
    return this.#sceneCommits.pending;
  }
  public get sceneCommitProof(): number | undefined {
    return this.#sceneCommits.proof;
  }
  public releaseInitialOverscan(): void {
    runtime.assertSceneActive(this.#disposed);
    this.#visibilityCoordinator.setInitialVisibleOnly(false);
    this.#frames.schedule();
  }
  public setScrollPreloadMarginPx(value: number): void {
    runtime.assertSceneActive(this.#disposed);
    if (this.#visibilityCoordinator.setScrollPreloadMarginPx(value)) this.#frames.schedule();
  }
  public setActiveDocumentMemoryPressure(active: boolean): void {
    runtime.assertSceneActive(this.#disposed);
    this.#resourcePolicy.setActiveDocumentMemoryPressure(active);
    this.#visibilityCoordinator.setActiveDocumentMemoryPressure(active);
    if (this.#content.hasMountedWork) this.#frames.schedule();
  }
  public setDocumentPrewarmEnabled(enabled: boolean): void {
    runtime.assertSceneActive(this.#disposed);
    this.#visibilityCoordinator.setDocumentPrewarmEnabled(enabled);
  }
  public readonly memoryUsage = () => this.#resourcePolicy.memoryUsage();
  public beginPreviewCommit(): PreviewCommitHandoff {
    runtime.assertSceneActive(this.#disposed);
    return this.#previewInput.commits.begin();
  }
  public setCamera(camera: Scene.SceneCamera): void {
    runtime.validateCamera(camera);
    if (camera.x === this.#camera.x && camera.zoom === this.#camera.zoom) return;
    const zoomChanged = camera.zoom !== this.#camera.zoom;
    if (this.#visibilityCoordinator.initialVisibleOnly) this.#sceneCommits.markPending();
    this.#camera = camera;
    this.#frameWriter.setCamera(camera);
    this.#visibilityCoordinator.setContext(camera, this.#viewport);
    if (zoomChanged) this.#backgroundDirty = true;
    this.#frames.schedule();
  }
  public setViewport(viewport: Scene.SceneViewport): void {
    runtime.validateViewport(viewport);
    this.#layoutDirty = false;
    if (runtime.sameViewport(this.#viewport, viewport)) return;
    if (this.#visibilityCoordinator.initialVisibleOnly) this.#sceneCommits.markPending();
    this.#viewport = viewport;
    this.#frameWriter.invalidateCursorLayout();
    this.#visibilityCoordinator.setContext(this.#camera, viewport);
    this.#frames.schedule();
  }
  public invalidateLayout(requestCommit = false): void {
    runtime.assertSceneActive(this.#disposed);
    this.#layoutInvalidationVersion += 1;
    this.#layoutDirty = true;
    this.#frameWriter.invalidateCursorLayout();
    if (requestCommit || this.#visibilityCoordinator.initialVisibleOnly)
      this.#sceneCommits.markPending();
    this.#frames.schedule();
  }
  public setPage(page: Schema.PageV1, height = this.#pageHeight): void {
    runtime.assertSceneActive(this.#disposed);
    if (!Number.isFinite(height) || height <= 0)
      throw new RangeError("Page height must be finite and positive.");
    if (page === this.#page && height === this.#pageHeight) return;
    this.#page = page;
    this.#pageHeight = height;
    this.#backgroundDirty = true;
    this.#sceneCommits.markPending();
    this.#frames.schedule();
  }
  public setScheme(scheme: Scene.DocumentScheme): void {
    runtime.assertSceneActive(this.#disposed);
    this.#frameWriter.setScheme(scheme);
    this.#frames.schedule();
  }
  public requestToolCursorFrame(read: SceneToolCursorFrameReader): void {
    runtime.assertSceneActive(this.#disposed);
    this.#frameWriter.requestToolCursorFrame(read);
    this.#frames.schedule(false);
  }
  public moveToolCursor(x: number, y: number): void {
    runtime.assertSceneActive(this.#disposed);
    this.#frameWriter.moveToolCursor(x, y);
  }
  public setLivePath(path: Scene.LivePathState | null): void {
    runtime.assertSceneActive(this.#disposed);
    this.#frameWriter.setLivePath(path);
    this.#frames.schedule();
  }
  public updateLiveStroke(
    preview: Scene.SceneLiveStrokePreview,
    style: Schema.StrokeStyleV1,
    tool: Schema.StrokeElementV1["tool"],
  ): void {
    runtime.assertSceneActive(this.#disposed);
    this.#liveStroke.update(preview, style, tool);
  }
  public commitLivePath(id: string): void {
    runtime.assertSceneActive(this.#disposed);
    this.#frameWriter.commitLivePath(id);
    this.#frameWriter.livePathCommits.settle((key) => this.#content.hasMounted(key));
    this.#frames.schedule();
  }
  public commitLiveStroke(id: string, prepared?: PreparedScenePath): void {
    runtime.assertSceneActive(this.#disposed);
    if (prepared !== undefined)
      this.#pathCache.retainPreparedFromStore(id, prepared, this.#options.store);
    this.#liveStroke.commit(id, (band) => this.#dom.group(band));
    this.#frames.schedule();
  }
  public clearLiveStroke(): void {
    runtime.assertSceneActive(this.#disposed);
    this.#liveStroke.clear();
  }
  public setOverlayPath(d: string | null): void {
    runtime.assertSceneActive(this.#disposed);
    if (!this.#frameWriter.setOverlayPath(d)) return;
    this.#frames.schedule();
  }
  public setSelectionHighlightsEnabled(enabled: boolean): void {
    runtime.assertSceneActive(this.#disposed);
    this.#content.setSelectionHighlightsEnabled(enabled);
    this.#frames.schedule();
  }
  public setSelectedElements(ids: ReadonlySet<string>): void {
    runtime.assertSceneActive(this.#disposed);
    this.#content.setSelectedElements(ids);
    this.#frames.schedule();
  }
  public setSelectionOverlayPath(
    d: string | null,
    fill: "accent" | "none" = "accent",
    handles: string | null = null,
  ): void {
    runtime.assertSceneActive(this.#disposed);
    this.#frameWriter.setSelectionPath(d, handles, fill);
    this.#frames.schedule();
  }
  public setSnapMarkerPath(d: string | null): void {
    runtime.assertSceneActive(this.#disposed);
    this.#frameWriter.setSnapPath(d);
    this.#frames.schedule();
  }
  public suppressMotionForNextDelta(ids: readonly string[]): void {
    runtime.assertSceneActive(this.#disposed);
    this.#motion.suppress(ids);
    this.#frames.schedule();
  }
  public interruptMotionForPointerDown(): void {
    runtime.assertSceneActive(this.#disposed);
    this.#motion.interruptForPointerDown();
    this.#content.interruptMembershipFades();
  }
  public setReducedMotion(reduced: boolean): void {
    runtime.assertSceneActive(this.#disposed);
    this.#motion.setReducedMotion(reduced);
    this.#content.setReducedMotion(reduced);
    this.#frames.schedule();
  }
  public flushPointerFeedbackFrame(
    deadline = this.#scheduler.deadline(),
    refreshCursorLayout = false,
  ): void {
    runtime.assertSceneActive(this.#disposed);
    if (refreshCursorLayout) this.#frameWriter.readToolCursor(true);
    this.#frameWriter.writePointerFeedback(
      this.#transformPreviews,
      this.#elementPreviews,
      this.#motion,
      deadline,
      () => this.#scheduler.now(),
    );
  }
  public setPreviewTransform(
    ids: readonly string[],
    transform: string | null,
    version: number,
    strokeWidth: Scene.PreviewStrokeWidth = "scale",
    transformBounds?: Scene.PreviewBoundsTransform,
    matrix?: ProgressivePreviewTransform["matrix"] | ProgressivePreviewTransform,
  ): void {
    runtime.assertSceneActive(this.#disposed);
    this.#previewInput.setTransform(ids, transform, version, strokeWidth, transformBounds, matrix);
  }
  public clearPreviewTransforms(): void {
    runtime.assertSceneActive(this.#disposed);
    this.#previewInput.clear("transform");
  }
  public setElementPreviews(items: readonly Schema.InkElementV1[], frame: number): void {
    runtime.assertSceneActive(this.#disposed);
    this.#previewInput.setElements(items, frame);
  }
  public setProgressiveElementPreviews(
    ids: readonly string[],
    materialize: (id: string) => Schema.InkElementV1 | undefined,
    version: number,
    feedback?: ProgressivePreviewTransform,
    mode?: ProgressivePreviewPurpose,
  ): void {
    runtime.assertSceneActive(this.#disposed);
    this.#previewInput.setProgressiveElements(ids, materialize, version, feedback, mode);
  }
  public clearProgressiveElementPreviews(): void {
    runtime.assertSceneActive(this.#disposed);
    this.#previewInput.clear("progressive");
  }
  public clearElementPreviews(): void {
    runtime.assertSceneActive(this.#disposed);
    this.#previewInput.clear("element");
  }
  public promoteVisible(id: string): void {
    runtime.assertSceneActive(this.#disposed);
    if (this.#content.promoteVisible(id)) this.#frames.schedule();
  }
  public instrumentation(): Scene.SceneInstrumentationSnapshot {
    return this.#resourcePolicy.instrumentation(this.#stats, this.#backgroundCache);
  }
  public get layoutInvalidationVersion(): number {
    return this.#layoutInvalidationVersion;
  }
  public resetInstrumentation(): void {
    this.#resourcePolicy.resetInstrumentation(this.#stats, this.#backgroundCache);
  }
  public readonly mountedIds = (band: RenderBand) => this.#content.mountedIds(band);
  public replaceGeneration(): void {
    runtime.assertSceneActive(this.#disposed);
    if (this.#visibilityCoordinator.initialVisibleOnly) this.#sceneCommits.markPending();
    this.#frames.replaceGeneration();
    this.#visibilityCoordinator.invalidate();
    this.#frames.schedule();
  }
  public destroy(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#frames.dispose();
    this.#visibilityCoordinator.release();
    this.#liveStroke.dispose();
    this.#frameWriter.release();
    this.#previewInput.commits.release();
    this.#motion.release();
    this.#deltas.release();
    this.#dom.release();
    this.#backgroundCache.clear();
    this.#content.release();
    this.#transformPreviews.release();
    this.#elementPreviews.release();
    this.#resourcePolicy.releaseCaches();
    this.#sceneCommits.release();
  }
  private renderFrame(frameTime: number, scene: boolean): void {
    if (!scene) return this.#frameWriter.flushToolCursor();
    if (this.#layoutDirty || this.#backgroundDirty) this.#visibility.removalReuse.invalidate();
    this.#motion.expireSuppression();
    const startedAt = Number.isFinite(frameTime) ? frameTime : this.#scheduler.now();
    const deadline = this.#scheduler.deadline();
    if (this.#layoutDirty) {
      this.#viewport = this.#visibilityCoordinator.readViewport(
        this.#options.layout,
        this.#viewport,
        this.#camera,
        this.#stats,
      );
      this.#layoutDirty = false;
    }
    this.#frameWriter.readToolCursor();
    this.#visibilityCoordinator.releaseCommittedPreview(this.#previewInput.commits);
    this.#visibilityCoordinator.prepare(this.#viewport, this.#camera, deadline);
    this.#transformPreviews.refreshContext();
    this.flushPointerFeedbackFrame(deadline);
    const previewTransforms = this.#elementPreviews.previewTransforms(
      this.#transformPreviews.values,
    );
    this.#visibilityCoordinator.releaseLostPreviews(
      previewTransforms,
      () => this.#elementPreviews.values,
    );
    this.#motion.writeSelectionFeedback(startedAt);
    const hadRunCommit = this.#content.hasRunCommitOwnership;
    let work = this.#frameWork.write(
      startedAt,
      deadline,
      previewTransforms,
      this.#elementPreviews.values,
    );
    if (hadRunCommit && !this.#content.hasRunCommitOwnership) {
      // The next admitted frame rechecks the existing deferred-exit dependency.
      work = { ...work, pendingVisibility: true };
    }
    this.#visibilityCoordinator.finishMountedFrame(
      this.#liveStroke,
      this.#frameWriter.livePathCommits,
      this.#motion,
      startedAt,
    );
    this.#frameWork.complete(work, this.#sceneCommits, this.#frames);
    if (this.#scheduler.now() < deadline) this.#resourcePolicy.notifyUsageChanged();
  }
  private writeBackground(deadline: number, allowAtomic = false): boolean {
    if (!this.#backgroundDirty || this.#viewport === undefined) return false;
    if (!allowAtomic && this.#scheduler.now() >= deadline) {
      this.#stats.backgroundBudgetDeferrals += 1;
      return true;
    }
    this.#frameWriter.writeBackground(this.#page, this.#pageHeight, this.#camera.zoom);
    this.#backgroundDirty = false;
    return false;
  }
  private createPreviewInput(): ScenePreviewInput {
    return new ScenePreviewInput(this.#motion, this.#content, {
      camera: () => this.#camera,
      elements: this.#elementPreviews,
      schedule: () => this.#frames.schedule(),
      transforms: this.#transformPreviews,
      viewport: () => this.#viewport,
      visibility: this.#visibilityCoordinator,
    });
  }
}
