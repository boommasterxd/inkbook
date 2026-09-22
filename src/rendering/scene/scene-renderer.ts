import { SceneFrameScheduler } from "./scene-frame-scheduler";
import type { SceneToolCursor, SceneToolCursorFrameReader } from "./tool-cursor";
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
    const budget = options.frameBudgetMs ?? DEFAULT_FRAME_BUDGET_MS;
    this.#frameBudgetMs = typeof budget === "function" ? budget : () => budget;
    runtime.validateFrameBudget(this.#frameBudgetMs());
    this.#scheduler =
      options.scheduler ?? runtime.browserScheduler(options.container.ownerDocument);
    this.#frames = new SceneFrameScheduler(this.#scheduler, this.#stats, (time, scene) =>
      this.renderFrame(time, scene),
    );
    this.#dom = new SceneDom(
      options.container,
      options.accessibleName ?? "Inkbook canvas",
      options.inputHandlers ?? {},
    );
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
    );
    this.#motion = new SceneMotionController(
      this.#dom,
      this.#content,
      this.#stats,
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
      this.#frames.schedule();
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
  public get mountedCount(): number {
    return this.#content.mountedCount;
  }
  public applyDelta(delta: Scene.SceneStoreDelta): void {
    this.assertActive();
    this.#deltas.apply(delta);
    this.#liveStroke.settleCommits((id) => this.#options.store.get(id) === undefined);
    this.#frameWriter.livePathCommits.settle((id) => this.#options.store.get(id) === undefined);
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
    this.#frames.schedule();
  }
  public setViewport(viewport: Scene.SceneViewport): void {
    runtime.validateViewport(viewport);
    if (runtime.sameViewport(this.#viewport, viewport)) return;
    this.#viewport = viewport;
    this.#frameWriter.invalidateCursorLayout();
    this.#transformPreviews.setContext(this.#camera, viewport);
    this.#elementPreviews.refreshProgressiveContext(viewport, this.#camera);
    this.#layoutDirty = false;
    this.#visibilityCoordinator.invalidate();
    this.#frames.schedule();
  }
  public invalidateLayout(requestCommit = false, flushCursor = false): void {
    this.assertActive();
    this.#layoutDirty = true;
    this.#frameWriter.invalidateCursorLayout(flushCursor);
    if (requestCommit) this.#sceneCommits.markPending();
    this.#frames.schedule();
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
  public setToolCursor(state: SceneToolCursor | null): void {
    this.assertActive();
    this.#frameWriter.setToolCursor(state);
    this.#frames.schedule(false);
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
  public commitLiveStroke(id: string): void {
    this.assertActive();
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
    deadline = this.#scheduler.now() + runtime.validateFrameBudget(this.#frameBudgetMs()),
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
    this.#content.setElementFade(ids, this.#motion.duration(durationMs), {
      deadline: this.#scheduler.now() + runtime.validateFrameBudget(this.#frameBudgetMs()),
      now: () => this.#scheduler.now(),
    });
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
    stats.refreshCacheInstrumentation(this.#stats, this.#backgroundCache, this.#pathCache);
    this.#motion.refreshInstrumentation();
    return stats.snapshotInstrumentation(this.#stats);
  }
  public resetInstrumentation(): void {
    stats.resetInstrumentation(this.#stats);
    this.#pathCache.resetStatistics();
    this.#backgroundCache.resetStatistics();
    this.#motion.refreshInstrumentation();
  }
  public mountedIds(band: RenderBand): readonly string[] {
    return this.#content.mountedIds(band);
  }
  public replaceGeneration(): void {
    this.assertActive();
    this.#frames.replaceGeneration();
    this.#visibilityCoordinator.invalidate();
    this.#frames.schedule();
  }
  public destroy(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#frames.dispose();
    this.#liveStroke.dispose();
    this.#frameWriter.release();
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
  private renderFrame(frameTime: number, scene: boolean): void {
    if (!scene) {
      this.#frameWriter.flushToolCursor();
      return;
    }
    this.#motion.expireSuppression();
    const startedAt = Number.isFinite(frameTime) ? frameTime : this.#scheduler.now();
    const deadline = startedAt + runtime.validateFrameBudget(this.#frameBudgetMs());
    this.performReadPhase();
    this.#frameWriter.readToolCursor();
    if (this.#previewCommits.releaseCommitted()) {
      this.#content.materializePreviewGeometry(this.#transformPreviews.values);
      this.#transformPreviews.clear();
      this.#elementPreviews.clear();
      this.#visibilityCoordinator.releasePreviews();
    }
    this.#visibilityCoordinator.prepare(this.#viewport, this.#camera);
    this.#transformPreviews.refreshContext();
    this.flushPointerFeedbackFrame(deadline);
    const pendingFades = this.#content.flushElementFades(deadline, () => this.#scheduler.now());
    const pendingVisibility =
      this.#content.writeMountedChanges(deadline, () => this.#scheduler.now()) ||
      this.#content.reconcileVisibility(
        deadline,
        () => this.#scheduler.now(),
        this.#transformPreviews.values,
        this.#elementPreviews.values,
      );
    this.#liveStroke.settleCommits(
      (id) => this.#content.hasMounted(id) || !this.#visibility.contains(id),
    );
    this.#frameWriter.livePathCommits.settle(
      (id) => this.#content.hasMounted(id) || !this.#visibility.contains(id),
    );
    if (pendingVisibility) {
      this.#frames.schedule();
      stats.refreshCacheInstrumentation(this.#stats, this.#backgroundCache, this.#pathCache);
      this.#resourcePolicy.notifyUsageChanged();
      return;
    }
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
        this.#stats.backgroundBudgetDeferrals += 1;
      } else {
        this.#frameWriter.writeBackground(this.#page, this.#pageHeight, this.#camera.zoom);
        this.#backgroundDirty = false;
      }
    }
    if (!backgroundDeferred) this.#sceneCommits.completeFrame();
    const pendingMotion = this.#motion.write(startedAt, deadline, () => this.#scheduler.now());
    const overBudget = this.#scheduler.now() >= deadline;
    if (
      backgroundDeferred ||
      pendingPreview ||
      pendingMotion ||
      overBudget ||
      this.#content.hasPendingExitCleanup ||
      pendingFades
    )
      this.#frames.schedule();
    stats.refreshCacheInstrumentation(this.#stats, this.#backgroundCache, this.#pathCache);
    if (!overBudget) this.#resourcePolicy.notifyUsageChanged();
  }
  private performReadPhase(): void {
    if (!this.#layoutDirty) return;
    const viewport = this.#options.layout.readViewport();
    this.#stats.layoutReads += 1;
    runtime.validateViewport(viewport);
    if (!runtime.sameViewport(this.#viewport, viewport)) {
      this.#viewport = viewport;
      this.#transformPreviews.setContext(this.#camera, viewport);
      this.#elementPreviews.refreshProgressiveContext(viewport, this.#camera);
      this.#visibilityCoordinator.invalidate();
    }
    this.#layoutDirty = false;
  }
  private assertActive(): void {
    if (this.#disposed) throw new Error("The SVG scene renderer has been destroyed.");
  }
}
