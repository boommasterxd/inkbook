import type { RenderBand } from "../../domain/commands/render-bands";
import type * as Schema from "../../domain/schema/public";
import { SceneBackgroundCache } from "./background-cache";
import { DEFAULT_CAMERA, DEFAULT_FRAME_BUDGET_MS } from "./constants";
import { SceneContentRenderer } from "./content-renderer";
import type { ProgressivePreviewTransform } from "./progressive-element-preview";
import { SceneElementPreviews } from "./scene-element-previews";
import { SceneFrameWriter } from "./scene-frame-writer";
import * as stats from "./instrumentation";
import { ScenePathCache } from "./path-cache";
import { ScenePreviewCommitController, type PreviewCommitHandoff } from "./preview-commit-handoff";
import { SceneDom } from "./scene-dom";
import { SceneCommitCoordinator } from "./scene-commit-coordinator";
import { SceneDeltaCoordinator } from "./scene-delta-coordinator";
import { SceneLiveStrokeRenderer } from "./live-stroke-renderer";
import { SceneMotionController } from "./scene-motion-controller";
import { SceneResourcePolicy } from "./scene-resource-policy";
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
  #disposed = false;
  readonly #dom: SceneDom;
  readonly #frameBudgetMs: () => number;
  readonly #frameWriter: SceneFrameWriter;
  #frameHandle: number | undefined;
  #generation = 1;
  readonly #sceneCommits: SceneCommitCoordinator;
  readonly #deltas: SceneDeltaCoordinator;
  readonly #instrumentation: Scene.MutableSceneInstrumentation = stats.createInstrumentation();
  #layoutDirty = true;
  readonly #liveStroke: SceneLiveStrokeRenderer;
  readonly #motion: SceneMotionController;
  #page: Schema.PageV1;
  #pageHeight = 1;
  readonly #previewCommits: ScenePreviewCommitController;
  readonly #resourcePolicy: SceneResourcePolicy;
  readonly #pathCache = new ScenePathCache();
  readonly #elementPreviews: SceneElementPreviews;
  readonly #transformPreviews: SceneTransformPreviewController;
  readonly #scheduler: Scene.SceneScheduler;
  #viewport: Scene.SceneViewport | undefined;
  readonly #visibilityCoordinator: SceneVisibilityCoordinator;
  readonly #visibility: SceneVisibilityState;
  readonly #options: Scene.SceneRendererOptions;
  public constructor(options: Scene.SceneRendererOptions) {
    this.#options = options;
    this.#page = options.page;
    const configuredBudget = options.frameBudgetMs ?? DEFAULT_FRAME_BUDGET_MS;
    this.#frameBudgetMs =
      typeof configuredBudget === "function" ? configuredBudget : () => configuredBudget;
    runtime.validateFrameBudget(this.#frameBudgetMs());
    this.#scheduler =
      options.scheduler ?? runtime.browserScheduler(options.container.ownerDocument);
    this.#dom = new SceneDom(
      options.container,
      options.accessibleName ?? "Inkbook canvas",
      options.inputHandlers ?? {},
    );
    this.#frameWriter = new SceneFrameWriter(
      this.#dom,
      this.#backgroundCache,
      this.#instrumentation,
    );
    this.#visibility = new SceneVisibilityState(options.store, this.#instrumentation);
    this.#liveStroke = new SceneLiveStrokeRenderer(
      this.#dom.ownerDocument,
      this.#dom.liveStrokeGroup,
      (band) => this.#dom.placeLiveGroup("stroke", band),
      this.#instrumentation,
    );
    this.#content = new SceneContentRenderer(
      this.#dom,
      options.store,
      this.#visibility,
      this.#pathCache,
      this.#instrumentation,
    );
    this.#motion = new SceneMotionController(
      this.#dom,
      this.#content,
      this.#instrumentation,
      options.reducedMotion ?? false,
    );
    this.#resourcePolicy = new SceneResourcePolicy(
      this.#pathCache,
      this.#motion,
      options.onResourceUsageChanged ?? (() => undefined),
      () => this.#elementPreviews.progressive.memoryUsage() + this.#content.selectionTraceBytes(),
    );
    this.#visibilityCoordinator = new SceneVisibilityCoordinator(
      this.#content,
      this.#visibility,
      this.#resourcePolicy,
    );
    this.#sceneCommits = new SceneCommitCoordinator(options.onSceneCommitted);
    this.#sceneCommits.markPending();
    this.#elementPreviews = new SceneElementPreviews(this.#content, options.store);
    this.#transformPreviews = new SceneTransformPreviewController(
      this.#content,
      options.store,
      this.#camera,
    );
    this.#previewCommits = new ScenePreviewCommitController(this.#motion, () => {
      this.#transformPreviews.clear();
      this.#elementPreviews.clear();
      this.#visibilityCoordinator.releasePreviews();
      this.schedule();
    });
    this.#deltas = new SceneDeltaCoordinator({
      commits: this.#sceneCommits,
      motion: this.#motion,
      previews: this.#previewCommits,
      routing: {
        content: this.#content,
        invalidateVisibility: () => this.#visibilityCoordinator.invalidate(),
        markOrderVisibilityDirty: () => this.#visibilityCoordinator.invalidateOrder(),
        pathCache: this.#pathCache,
        store: this.#options.store,
        visibility: this.#visibility,
      },
      schedule: () => this.schedule(),
    });
    this.schedule();
  }
  public get inputSurface(): HTMLDivElement {
    return this.#dom.inputSurface;
  }
  public get svg(): SVGSVGElement {
    return this.#dom.svg;
  }
  public get mountedCount(): number {
    return this.#content.mountedCount;
  }
  public applyDelta(delta: Scene.SceneStoreDelta): void {
    this.assertActive();
    this.#deltas.apply(delta);
    this.#liveStroke.settleCommits((id) => this.#options.store.get(id) === undefined);
  }
  public get hasPendingSceneCommit(): boolean {
    return this.#sceneCommits.pending;
  }
  public setActiveDocumentMemoryPressure(active: boolean): void {
    this.assertActive();
    this.#resourcePolicy.setActiveDocumentMemoryPressure(active);
  }
  public memoryUsage(): ReturnType<SceneResourcePolicy["memoryUsage"]> {
    return this.#resourcePolicy.memoryUsage();
  }
  public beginPreviewCommit(): PreviewCommitHandoff {
    this.assertActive();
    return this.#previewCommits.begin();
  }
  public setCamera(camera: Scene.SceneCamera): void {
    runtime.validateCamera(camera);
    if (camera.x === this.#camera.x && camera.zoom === this.#camera.zoom) return;
    const zoomChanged = camera.zoom !== this.#camera.zoom;
    this.#camera = camera;
    this.#frameWriter.setCamera(camera);
    this.#transformPreviews.setContext(camera, this.#viewport);
    this.#elementPreviews.refreshProgressiveContext(this.#viewport, camera);
    this.#visibilityCoordinator.invalidate();
    if (zoomChanged) this.#backgroundDirty = true;
    this.schedule();
  }
  public setViewport(viewport: Scene.SceneViewport): void {
    runtime.validateViewport(viewport);
    if (runtime.sameViewport(this.#viewport, viewport)) return;
    this.#viewport = viewport;
    this.#transformPreviews.setContext(this.#camera, viewport);
    this.#elementPreviews.refreshProgressiveContext(viewport, this.#camera);
    this.#layoutDirty = false;
    this.#visibilityCoordinator.invalidate();
    this.schedule();
  }
  public invalidateLayout(requestCommit = false): void {
    this.assertActive();
    this.#layoutDirty = true;
    if (requestCommit) this.#sceneCommits.markPending();
    this.schedule();
  }
  public setPage(page: Schema.PageV1, height = this.#pageHeight): void {
    this.assertActive();
    if (!Number.isFinite(height) || height <= 0) {
      throw new RangeError("Page height must be finite and positive.");
    }
    if (page === this.#page && height === this.#pageHeight) return;
    this.#page = page;
    this.#pageHeight = height;
    this.#backgroundDirty = true;
    this.#sceneCommits.markPending();
    this.schedule();
  }
  public setScheme(scheme: Scene.DocumentScheme): void {
    this.assertActive();
    this.#frameWriter.setScheme(scheme);
    this.schedule();
  }
  public setLivePath(path: Scene.LivePathState | null): void {
    this.assertActive();
    this.#frameWriter.setLivePath(path);
    this.schedule();
  }
  public updateLiveStroke(
    preview: Scene.SceneLiveStrokePreview,
    style: Schema.StrokeStyleV1,
    tool: Schema.StrokeElementV1["tool"],
  ): void {
    this.assertActive();
    this.#liveStroke.update(preview, style, tool);
  }
  public commitLiveStroke(id: string): void {
    this.assertActive();
    this.#liveStroke.commit(id, (band) => this.#dom.group(band));
    this.schedule();
  }
  public clearLiveStroke(): void {
    this.assertActive();
    this.#liveStroke.clear();
  }
  public setOverlayPath(d: string | null): void {
    this.assertActive();
    if (!this.#frameWriter.setOverlayPath(d)) return;
    this.schedule();
  }
  public setSelectionHighlightsEnabled(enabled: boolean): void {
    this.assertActive();
    this.#content.setSelectionHighlightsEnabled(enabled);
    this.schedule();
  }
  public setSelectedElements(ids: ReadonlySet<string>): void {
    this.assertActive();
    this.#content.setSelectedElements(ids);
    this.schedule();
  }
  public setSelectionOverlayPath(
    d: string | null,
    fill: "accent" | "none" = "accent",
    handles: string | null = null,
  ): void {
    this.assertActive();
    this.#frameWriter.setSelectionPath(d, handles, fill);
    this.schedule();
  }
  public setSnapMarkerPath(d: string | null): void {
    this.assertActive();
    this.#frameWriter.setSnapPath(d);
    this.schedule();
  }
  public suppressMotionForNextDelta(ids: readonly string[]): void {
    this.assertActive();
    this.#motion.suppress(ids);
    this.schedule();
  }
  public interruptMotionForPointerDown(): void {
    this.assertActive();
    this.#motion.interruptForPointerDown();
  }
  public setReducedMotion(reduced: boolean): void {
    this.assertActive();
    this.#motion.setReducedMotion(reduced);
    this.schedule();
  }
  public flushPointerFeedbackFrame(): void {
    this.assertActive();
    this.#frameWriter.writePointerFeedback(
      this.#transformPreviews,
      this.#elementPreviews,
      this.#motion,
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
    this.schedule();
  }
  public clearPreviewTransforms(): void {
    this.assertActive();
    if (this.#previewCommits.requestClear()) return;
    this.#transformPreviews.clear();
    this.#visibilityCoordinator.releasePreviews();
    this.schedule();
  }
  public setElementFade(ids: readonly string[], durationMs: number): void {
    this.assertActive();
    runtime.validateNonNegativeDuration(durationMs);
    this.#deltas.addFades(ids);
    this.#content.setElementFade(ids, this.#motion.duration(durationMs), this.#scheduler.now());
    if (this.#content.pendingElementFades) this.schedule();
  }
  public clearElementFade(ids: readonly string[]): void {
    this.assertActive();
    this.#content.setElementFade(this.#deltas.removeFades(ids), null);
  }
  public setElementPreviews(items: readonly Schema.InkElementV1[], frame: number): void {
    this.assertActive();
    runtime.validatePreviewVersion(frame, "Element preview");
    if (this.#elementPreviews.immediate.set(items, frame)) this.schedule();
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
    this.schedule();
  }
  public clearProgressiveElementPreviews(): void {
    this.assertActive();
    this.#elementPreviews.clearProgressive();
    this.schedule();
  }
  public clearElementPreviews(): void {
    this.assertActive();
    if (this.#previewCommits.requestClear()) return;
    this.#elementPreviews.clear();
    this.#visibilityCoordinator.releasePreviews();
    this.schedule();
  }
  public promoteVisible(id: string): void {
    this.assertActive();
    if (this.#content.promoteVisible(id)) this.schedule();
  }
  public instrumentation(): Scene.SceneInstrumentationSnapshot {
    this.refreshCacheInstrumentation();
    this.#motion.refreshInstrumentation();
    return stats.snapshotInstrumentation(this.#instrumentation);
  }
  public resetInstrumentation(): void {
    stats.resetInstrumentation(this.#instrumentation);
    this.#pathCache.resetStatistics();
    this.#backgroundCache.resetStatistics();
    this.#motion.refreshInstrumentation();
  }
  public mountedIds(band: RenderBand): readonly string[] {
    return this.#content.mountedIds(band);
  }
  public replaceGeneration(): void {
    this.assertActive();
    this.#generation += 1;
    if (this.#frameHandle !== undefined) {
      this.#scheduler.cancelAnimationFrame(this.#frameHandle);
      this.#frameHandle = undefined;
    }
    this.#visibilityCoordinator.invalidate();
    this.schedule();
  }
  public destroy(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    if (this.#frameHandle !== undefined) {
      this.#scheduler.cancelAnimationFrame(this.#frameHandle);
      this.#frameHandle = undefined;
    }
    this.#liveStroke.dispose();
    this.#previewCommits.release();
    this.#motion.release();
    this.#deltas.release();
    this.#dom.release();
    this.#pathCache.release();
    this.#backgroundCache.clear();
    this.#visibility.release();
    this.#content.release();
    this.#transformPreviews.release();
    this.#elementPreviews.release();
    this.#sceneCommits.release();
  }
  private schedule(): void {
    if (this.#disposed || this.#frameHandle !== undefined) return;
    const generation = this.#generation;
    let handle = 0;
    handle = this.#scheduler.requestAnimationFrame((time) => {
      if (this.#frameHandle === handle) this.#frameHandle = undefined;
      this.renderFrame(generation, time);
    });
    this.#frameHandle = handle;
    this.#instrumentation.scheduledFrames += 1;
  }
  private renderFrame(generation: number, frameTime: number): void {
    if (this.#disposed || generation !== this.#generation) {
      this.#instrumentation.staleFrames += 1;
      return;
    }
    this.#motion.expireSuppression();
    this.#instrumentation.frames += 1;
    const startedAt = Number.isFinite(frameTime) ? frameTime : this.#scheduler.now();
    const deadline = startedAt + runtime.validateFrameBudget(this.#frameBudgetMs());
    this.performReadPhase();
    if (this.#previewCommits.releaseCommitted()) {
      this.#content.materializePreviewGeometry(this.#transformPreviews.values);
      this.#transformPreviews.clear();
      this.#elementPreviews.clear();
      this.#visibilityCoordinator.releasePreviews();
    }
    this.#visibilityCoordinator.prepare(this.#viewport, this.#camera);
    this.#transformPreviews.refreshContext();
    this.flushPointerFeedbackFrame();
    const pendingFades = this.#content.flushElementFades(deadline, () => this.#scheduler.now());
    const pendingVisibility =
      this.#content.writeMountedChanges(deadline, () => this.#scheduler.now()) ||
      this.#content.reconcileVisibility(
        deadline,
        () => this.#scheduler.now(),
        this.#transformPreviews.values,
        this.#elementPreviews.values,
      );
    if (pendingVisibility) {
      this.schedule();
      this.refreshCacheInstrumentation();
      this.#resourcePolicy.notifyUsageChanged();
      return;
    }
    this.#liveStroke.settleCommits(
      (id) => this.#content.hasMounted(id) || !this.#visibility.contains(id),
    );
    const mountedIds = this.#content.takeNewlyMountedIds();
    this.#motion.bindMountedEntrances(mountedIds);
    this.#motion.finishEntranceBatch();
    this.#elementPreviews.applyMounted(mountedIds);
    const pendingPreview = this.#elementPreviews.progressive.write(deadline, () =>
      this.#scheduler.now(),
    );
    let backgroundDeferred = false;
    if (this.#backgroundDirty && this.#viewport !== undefined) {
      if (this.#scheduler.now() >= deadline) {
        backgroundDeferred = true;
        this.#instrumentation.backgroundBudgetDeferrals += 1;
      } else {
        this.#frameWriter.writeBackground(this.#page, this.#pageHeight, this.#camera.zoom);
        this.#backgroundDirty = false;
      }
    }
    if (!backgroundDeferred) this.#sceneCommits.completeFrame();
    const pendingMotion = this.#motion.write(startedAt);
    const overBudget = this.#scheduler.now() >= deadline;
    if (
      backgroundDeferred ||
      pendingPreview ||
      pendingMotion ||
      overBudget ||
      this.#content.hasPendingExitCleanup ||
      pendingFades
    )
      this.schedule();
    if (overBudget) {
      this.refreshCacheInstrumentation();
      return;
    }
    this.refreshCacheInstrumentation();
    this.#resourcePolicy.notifyUsageChanged();
  }
  private performReadPhase(): void {
    if (!this.#layoutDirty) return;
    const viewport = this.#options.layout.readViewport();
    this.#instrumentation.layoutReads += 1;
    runtime.validateViewport(viewport);
    if (!runtime.sameViewport(this.#viewport, viewport)) {
      this.#viewport = viewport;
      this.#transformPreviews.setContext(this.#camera, viewport);
      this.#elementPreviews.refreshProgressiveContext(viewport, this.#camera);
      this.#visibilityCoordinator.invalidate();
    }
    this.#layoutDirty = false;
  }
  private refreshCacheInstrumentation(): void {
    stats.refreshCacheInstrumentation(
      this.#instrumentation,
      this.#backgroundCache,
      this.#pathCache,
    );
  }
  private assertActive(): void {
    if (this.#disposed) throw new Error("The SVG scene renderer has been destroyed.");
  }
}
