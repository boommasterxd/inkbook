import { SceneFrameScheduler } from "./scene-frame-scheduler";
import type { SceneFrameObserver } from "./scene-frame-diagnostics";
import type { SceneToolCursorFrameReader } from "./tool-cursor";
import type { RenderBand } from "../../domain/commands/render-bands";
import type * as Schema from "../../domain/schema/public";
import { SceneBackgroundCache } from "./background-cache";
import { DetachedSceneElementCache } from "./detached-element-cache";
import { DEFAULT_CAMERA } from "./constants";
import { SceneContentRenderer } from "./content-renderer";
import type { ProgressivePreviewTransform } from "./progressive-element-preview";
import { SceneElementPreviews } from "./scene-element-previews";
import { SceneFrameWriter } from "./scene-frame-writer";
import { SceneFrameWork } from "./scene-frame-work";
import * as stats from "./instrumentation";
import { ScenePathCache, type PreparedScenePath } from "./path-cache";
import { ScenePreviewCommitController, type PreviewCommitHandoff } from "./preview-commit-handoff";
import { SceneDom } from "./scene-dom";
import { SceneCommitCoordinator } from "./scene-commit-coordinator";
import { SceneContentScheduler } from "./scene-content-scheduler";
import { SceneDeltaCoordinator } from "./scene-delta-coordinator";
import { SceneLiveStrokeRenderer } from "./live-stroke-renderer";
import { SceneMotionController } from "./scene-motion-controller";
import { SceneResourcePolicy, validateScrollPreloadMargin } from "./scene-resource-policy";
import { SceneVisibilityCoordinator } from "./scene-visibility-coordinator";
import * as runtime from "./scene-runtime";
import type * as Scene from "./types";
import { SceneTransformPreviewController } from "./transform-preview-controller";
import { SceneVisibilityState } from "./visibility-state";
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
  readonly #stats: Scene.MutableSceneInstrumentation = stats.createInstrumentation();
  #layoutDirty = true;
  readonly #liveStroke: SceneLiveStrokeRenderer;
  readonly #motion: SceneMotionController;
  #page: Schema.PageV1;
  #pageHeight = 1;
  readonly #previewCommits: ScenePreviewCommitController;
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
    this.#dom.onSurfaceInvalidated = this.#frames.schedule;
    this.#frameWriter = new SceneFrameWriter(this.#dom, this.#backgroundCache, this.#stats);
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
      },
    );
    this.#contentScheduler = new SceneContentScheduler(this.#content, this.#scheduler);
    const reducedMotion = options.reducedMotion ?? false;
    this.#motion = new SceneMotionController(this.#dom, this.#content, this.#stats, reducedMotion);
    this.#resourcePolicy = new SceneResourcePolicy(
      this.#pathCache,
      this.#motion,
      options.onResourceUsageChanged ?? (() => undefined),
      () => this.#visibilityCoordinator.previewMemoryUsage(),
      this.#detachedCache,
    );
    this.#elementPreviews = new SceneElementPreviews(this.#content, options.store);
    this.#transformPreviews = new SceneTransformPreviewController(
      this.#content,
      options.store,
      this.#camera,
    );
    this.#visibilityCoordinator = new SceneVisibilityCoordinator(
      this.#content,
      this.#visibility,
      this.#resourcePolicy,
      this.#transformPreviews,
      this.#elementPreviews,
      { cache: this.#pathCache, onPrepared: () => this.#frames.schedule(), scene: options },
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
    this.#previewCommits = new ScenePreviewCommitController(this.#motion, () => {
      this.#transformPreviews.clear();
      this.#elementPreviews.clear();
      this.#visibilityCoordinator.releasePreviews();
      this.#frames.schedule();
    });
    this.#deltas = new SceneDeltaCoordinator({
      commits: this.#sceneCommits,
      motion: this.#motion,
      previews: this.#previewCommits,
      routing: {
        content: this.#content,
        detachedCache: this.#detachedCache,
        invalidateVisibility: () => this.#visibilityCoordinator.invalidate(),
        markOrderVisibilityDirty: () => this.#visibilityCoordinator.invalidateOrder(),
        pathCache: this.#pathCache,
        store: this.#options.store,
        visibility: this.#visibility,
      },
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
  public get mountedCount(): number {
    return this.#content.mountedCount;
  }
  public applyDelta(delta: Scene.SceneStoreDelta): void {
    this.assertActive();
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
    this.assertActive();
    this.#visibilityCoordinator.setInitialVisibleOnly(false);
    this.#frames.schedule();
  }
  public setScrollPreloadMarginPx(value: number): void {
    this.assertActive();
    if (this.#visibilityCoordinator.setScrollPreloadMarginPx(value)) this.#frames.schedule();
  }
  public setActiveDocumentMemoryPressure(active: boolean): void {
    this.assertActive();
    this.#resourcePolicy.setActiveDocumentMemoryPressure(active);
    this.#visibilityCoordinator.setActiveDocumentMemoryPressure(active);
    if (this.#content.hasMountedWork) this.#frames.schedule();
  }
  public setDocumentPrewarmEnabled(enabled: boolean): void {
    this.assertActive();
    this.#visibilityCoordinator.setDocumentPrewarmEnabled(enabled);
  }
  public readonly memoryUsage = () => this.#resourcePolicy.memoryUsage();
  public beginPreviewCommit(): PreviewCommitHandoff {
    this.assertActive();
    return this.#previewCommits.begin();
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
    this.assertActive();
    this.#layoutDirty = true;
    this.#frameWriter.invalidateCursorLayout();
    if (requestCommit || this.#visibilityCoordinator.initialVisibleOnly)
      this.#sceneCommits.markPending();
    this.#frames.schedule();
  }
  public setPage(page: Schema.PageV1, height = this.#pageHeight): void {
    this.assertActive();
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
    this.assertActive();
    this.#frameWriter.setScheme(scheme);
    this.#frames.schedule();
  }
  public requestToolCursorFrame(read: SceneToolCursorFrameReader): void {
    this.assertActive();
    this.#frameWriter.requestToolCursorFrame(read);
    this.#frames.schedule(false);
  }
  public moveToolCursor(x: number, y: number): void {
    this.assertActive();
    this.#frameWriter.moveToolCursor(x, y);
  }
  public setLivePath(path: Scene.LivePathState | null): void {
    this.assertActive();
    this.#frameWriter.setLivePath(path);
    this.#frames.schedule();
  }
  public updateLiveStroke(
    preview: Scene.SceneLiveStrokePreview,
    style: Schema.StrokeStyleV1,
    tool: Schema.StrokeElementV1["tool"],
  ): void {
    this.assertActive();
    this.#liveStroke.update(preview, style, tool);
  }
  public commitLivePath(id: string): void {
    this.assertActive();
    this.#frameWriter.commitLivePath(id);
    this.#frameWriter.livePathCommits.settle((key) => this.#content.hasMounted(key));
    this.#frames.schedule();
  }
  public commitLiveStroke(id: string, prepared?: PreparedScenePath): void {
    this.assertActive();
    if (prepared !== undefined)
      this.#pathCache.retainPreparedFromStore(id, prepared, this.#options.store);
    this.#liveStroke.commit(id, (band) => this.#dom.group(band));
    this.#frames.schedule();
  }
  public clearLiveStroke(): void {
    this.assertActive();
    this.#liveStroke.clear();
  }
  public setOverlayPath(d: string | null): void {
    this.assertActive();
    if (!this.#frameWriter.setOverlayPath(d)) return;
    this.#frames.schedule();
  }
  public setSelectionHighlightsEnabled(enabled: boolean): void {
    this.assertActive();
    this.#content.setSelectionHighlightsEnabled(enabled);
    this.#frames.schedule();
  }
  public setSelectedElements(ids: ReadonlySet<string>): void {
    this.assertActive();
    this.#content.setSelectedElements(ids);
    this.#frames.schedule();
  }
  public setSelectionOverlayPath(
    d: string | null,
    fill: "accent" | "none" = "accent",
    handles: string | null = null,
  ): void {
    this.assertActive();
    this.#frameWriter.setSelectionPath(d, handles, fill);
    this.#frames.schedule();
  }
  public setSnapMarkerPath(d: string | null): void {
    this.assertActive();
    this.#frameWriter.setSnapPath(d);
    this.#frames.schedule();
  }
  public suppressMotionForNextDelta(ids: readonly string[]): void {
    this.assertActive();
    this.#motion.suppress(ids);
    this.#frames.schedule();
  }
  public interruptMotionForPointerDown(): void {
    this.assertActive();
    this.#motion.interruptForPointerDown();
  }
  public setReducedMotion(reduced: boolean): void {
    this.assertActive();
    this.#motion.setReducedMotion(reduced);
    this.#frames.schedule();
  }
  public flushPointerFeedbackFrame(
    deadline = this.#scheduler.deadline(),
    refreshCursorLayout = false,
  ): void {
    this.assertActive();
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
  ): void {
    this.assertActive();
    runtime.validatePreviewVersion(version, "Preview transform");
    this.#transformPreviews.set(ids, transform, version, strokeWidth);
    this.#frames.schedule();
  }
  public clearPreviewTransforms(): void {
    this.assertActive();
    if (this.#previewCommits.requestClear()) return;
    this.#transformPreviews.clear();
    this.#visibilityCoordinator.releasePreviews();
    this.#frames.schedule();
  }
  public setElementFade(ids: readonly string[], durationMs: number): void {
    this.assertActive();
    runtime.validateNonNegativeDuration(durationMs);
    this.#deltas.addFades(ids);
    const slice = this.#scheduler.shouldYield()
      ? undefined
      : { deadline: this.#scheduler.deadline(), now: () => this.#scheduler.now() };
    this.#content.setElementFade(ids, this.#motion.duration(durationMs), slice);
    if (this.#content.pendingElementFades) this.#frames.schedule();
  }
  public clearElementFade(ids: readonly string[]): void {
    this.assertActive();
    this.#content.setElementFade(this.#deltas.removeFades(ids), null);
  }
  public setElementPreviews(items: readonly Schema.InkElementV1[], frame: number): void {
    this.assertActive();
    runtime.validatePreviewVersion(frame, "Element preview");
    if (this.#elementPreviews.immediate.set(items, frame)) this.#frames.schedule();
  }
  public setProgressiveElementPreviews(
    ids: readonly string[],
    materialize: (id: string) => Schema.InkElementV1 | undefined,
    version: number,
    feedback?: ProgressivePreviewTransform,
  ): void {
    this.assertActive();
    runtime.validatePreviewVersion(version, "Progressive element preview");
    this.#elementPreviews.setProgressive(
      { feedback, ids, materialize, version },
      this.#viewport,
      this.#camera,
    );
    this.#frames.schedule();
  }
  public clearProgressiveElementPreviews(): void {
    this.assertActive();
    this.#elementPreviews.clearProgressive();
    this.#visibilityCoordinator.releasePreviews();
    this.#frames.schedule();
  }
  public clearElementPreviews(): void {
    this.assertActive();
    if (this.#previewCommits.requestClear()) return;
    this.#elementPreviews.clear();
    this.#visibilityCoordinator.releasePreviews();
    this.#frames.schedule();
  }
  public promoteVisible(id: string): void {
    this.assertActive();
    if (this.#content.promoteVisible(id)) this.#frames.schedule();
  }
  public instrumentation(): Scene.SceneInstrumentationSnapshot {
    return this.#resourcePolicy.instrumentation(this.#stats, this.#backgroundCache);
  }
  public observeFrames(observer: SceneFrameObserver | undefined): void {
    this.#frames.observeFrames(observer, () =>
      this.#content.frameDiagnosticState(this.#visibilityCoordinator.hasPendingQuery),
    );
  }
  public resetInstrumentation(): void {
    this.#resourcePolicy.resetInstrumentation(this.#stats, this.#backgroundCache);
  }
  public mountedIds(band: RenderBand): readonly string[] {
    return this.#content.mountedIds(band);
  }
  public replaceGeneration(): void {
    this.assertActive();
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
    this.#previewCommits.release();
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
    if (!scene) {
      this.#frameWriter.flushToolCursor();
      return;
    }
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
    this.#visibilityCoordinator.releaseCommittedPreview(this.#previewCommits);
    this.#visibilityCoordinator.prepare(this.#viewport, this.#camera, deadline);
    this.#transformPreviews.refreshContext();
    this.#visibilityCoordinator.releaseLostPreviews(
      this.#transformPreviews.values,
      () => this.#elementPreviews.values,
    );
    this.flushPointerFeedbackFrame(deadline);
    this.#motion.writeSelectionFeedback(startedAt);
    const work = this.#frameWork.write(
      startedAt,
      deadline,
      this.#transformPreviews.values,
      this.#elementPreviews.values,
    );
    this.#visibilityCoordinator.finishMountedFrame(
      this.#liveStroke,
      this.#frameWriter.livePathCommits,
      this.#motion,
      startedAt,
    );
    this.#frameWork.complete(work, this.#sceneCommits, this.#frames);
    this.#resourcePolicy.refreshInstrumentation(this.#stats, this.#backgroundCache);
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
  private assertActive(): void {
    if (this.#disposed) throw new Error("The SVG scene renderer has been destroyed.");
  }
}
