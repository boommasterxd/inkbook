import type { RenderBand } from "../../domain/commands/render-bands";
import type {
  InkElementV1,
  PageV1,
  StrokeElementV1,
  StrokeStyleV1,
} from "../../domain/schema/public";
import { SceneBackgroundCache } from "./background-cache";
import { DEFAULT_CAMERA, DEFAULT_FRAME_BUDGET_MS } from "./constants";
import { SceneContentRenderer } from "./content-renderer";
import { SceneElementPreviewController } from "./element-preview-controller";
import { SceneFrameWriter } from "./scene-frame-writer";
import {
  createInstrumentation,
  refreshCacheInstrumentation,
  resetInstrumentation,
  snapshotInstrumentation,
} from "./instrumentation";
import { ScenePathCache } from "./path-cache";
import { ScenePreviewCommitController, type PreviewCommitHandoff } from "./preview-commit-handoff";
import { SceneDom } from "./scene-dom";
import { SceneCommitCoordinator } from "./scene-commit-coordinator";
import { SceneDeltaCoordinator } from "./scene-delta-coordinator";
import { SceneLiveStrokeRenderer } from "./live-stroke-renderer";
import { SceneMotionController } from "./scene-motion-controller";
import { SceneResourcePolicy, visibilityPageBounds } from "./scene-resource-policy";
import {
  browserScheduler,
  sameViewport,
  validateFrameBudget,
  validateCamera,
  validateNonNegativeDuration,
  validatePreviewVersion,
  validateViewport,
} from "./scene-runtime";
import type {
  DocumentScheme,
  LivePathState,
  MutableSceneInstrumentation,
  PreviewStrokeWidth,
  SceneCamera,
  SceneInstrumentationSnapshot,
  SceneLiveStrokePreview,
  SceneRendererOptions,
  SceneScheduler,
  SceneStoreDelta,
  SceneViewport,
} from "./types";
import { SceneTransformPreviewController } from "./transform-preview-controller";
import { SceneVisibilityState } from "./visibility-state";
type Ids = ReadonlySet<string>;
export class SvgSceneRenderer {
  #backgroundDirty = true;
  readonly #backgroundCache = new SceneBackgroundCache();
  #camera: SceneCamera = DEFAULT_CAMERA;
  readonly #content: SceneContentRenderer;
  #disposed = false;
  readonly #dom: SceneDom;
  readonly #frameBudgetMs: () => number;
  readonly #frameWriter: SceneFrameWriter;
  #frameHandle: number | undefined;
  #generation = 1;
  readonly #sceneCommits: SceneCommitCoordinator;
  readonly #deltas: SceneDeltaCoordinator;
  readonly #instrumentation: MutableSceneInstrumentation = createInstrumentation();
  #layoutDirty = true;
  readonly #liveStroke: SceneLiveStrokeRenderer;
  readonly #motion: SceneMotionController;
  #orderVisibilityDirty = false;
  #page: PageV1;
  #pageHeight = 1;
  readonly #previewCommits: ScenePreviewCommitController;
  readonly #resourcePolicy: SceneResourcePolicy;
  readonly #pathCache = new ScenePathCache();
  readonly #elementPreviews: SceneElementPreviewController;
  readonly #transformPreviews: SceneTransformPreviewController;
  readonly #scheduler: SceneScheduler;
  #viewport: SceneViewport | undefined;
  #visibilityDirty = true;
  readonly #visibility: SceneVisibilityState;
  readonly #options: SceneRendererOptions;
  public constructor(options: SceneRendererOptions) {
    this.#options = options;
    this.#page = options.page;
    const configuredBudget = options.frameBudgetMs ?? DEFAULT_FRAME_BUDGET_MS;
    this.#frameBudgetMs =
      typeof configuredBudget === "function" ? configuredBudget : () => configuredBudget;
    validateFrameBudget(this.#frameBudgetMs());
    this.#scheduler = options.scheduler ?? browserScheduler(options.container.ownerDocument);
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
    );
    this.#sceneCommits = new SceneCommitCoordinator(options.onSceneCommitted);
    this.#sceneCommits.markPending();
    this.#elementPreviews = new SceneElementPreviewController(this.#content);
    this.#transformPreviews = new SceneTransformPreviewController(
      this.#content,
      options.store,
      this.#camera,
    );
    this.#previewCommits = new ScenePreviewCommitController(this.#motion, () => {
      this.#transformPreviews.clear();
      this.#elementPreviews.clear();
      this.reconcileReleasedPreviewVisibility();
      this.schedule();
    });
    this.#deltas = new SceneDeltaCoordinator({
      commits: this.#sceneCommits,
      motion: this.#motion,
      previews: this.#previewCommits,
      routing: {
        content: this.#content,
        invalidateVisibility: () => this.invalidateVisibility(),
        markOrderVisibilityDirty: () => {
          this.#orderVisibilityDirty = true;
        },
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
  public applyDelta(delta: SceneStoreDelta): void {
    this.assertActive();
    this.#deltas.apply(delta);
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
  public setCamera(camera: SceneCamera): void {
    validateCamera(camera);
    if (camera.x === this.#camera.x && camera.zoom === this.#camera.zoom) return;
    const zoomChanged = camera.zoom !== this.#camera.zoom;
    this.#camera = camera;
    this.#frameWriter.setCamera(camera);
    this.#transformPreviews.setContext(camera, this.#viewport);
    this.invalidateVisibility();
    if (zoomChanged) this.#backgroundDirty = true;
    this.schedule();
  }
  public setViewport(viewport: SceneViewport): void {
    validateViewport(viewport);
    if (sameViewport(this.#viewport, viewport)) return;
    this.#viewport = viewport;
    this.#transformPreviews.setContext(this.#camera, viewport);
    this.#layoutDirty = false;
    this.invalidateVisibility();
    this.schedule();
  }
  public invalidateLayout(): void {
    this.assertActive();
    this.#layoutDirty = true;
    this.schedule();
  }
  public setPage(page: PageV1, height = this.#pageHeight): void {
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
  public setScheme(scheme: DocumentScheme): void {
    this.assertActive();
    this.#frameWriter.setScheme(scheme);
    this.schedule();
  }
  public setLivePath(path: LivePathState | null): void {
    this.assertActive();
    this.#frameWriter.setLivePath(path);
    this.schedule();
  }
  public updateLiveStroke(
    preview: SceneLiveStrokePreview,
    style: StrokeStyleV1,
    tool: StrokeElementV1["tool"],
  ): void {
    this.assertActive();
    this.#liveStroke.update(preview, style, tool);
  }
  public clearLiveStroke(): void {
    this.assertActive();
    this.#liveStroke.clear();
  }
  public revertLiveStroke(): void {
    this.assertActive();
    this.#liveStroke.revert();
  }
  public setOverlayPath(d: string | null): void {
    this.assertActive();
    if (!this.#frameWriter.setOverlayPath(d)) return;
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
    strokeWidth: PreviewStrokeWidth = "scale",
  ): void {
    this.assertActive();
    validatePreviewVersion(version, "Preview transform");
    this.#transformPreviews.set(ids, transform, version, strokeWidth);
    this.schedule();
  }
  public clearPreviewTransforms(): void {
    this.assertActive();
    if (this.#previewCommits.requestClear()) return;
    this.#transformPreviews.clear();
    this.reconcileReleasedPreviewVisibility();
    this.schedule();
  }
  public setElementFade(ids: readonly string[], durationMs: number): void {
    this.assertActive();
    validateNonNegativeDuration(durationMs);
    this.#deltas.addFades(ids);
    this.#content.setElementFade(ids, this.#motion.duration(durationMs));
  }
  public clearElementFade(ids: readonly string[]): void {
    this.assertActive();
    const activeIds = this.#deltas.removeFades(ids);
    this.#content.setElementFade(activeIds, null);
  }
  public setElementPreviews(items: readonly InkElementV1[], frame: number, pressure?: Ids): void {
    this.assertActive();
    validatePreviewVersion(frame, "Element preview");
    if (this.#elementPreviews.set(items, frame, pressure)) this.schedule();
  }
  public clearElementPreviews(): void {
    this.assertActive();
    if (this.#previewCommits.requestClear()) return;
    this.#elementPreviews.clear();
    this.reconcileReleasedPreviewVisibility();
    this.schedule();
  }
  public promoteVisible(id: string): void {
    this.assertActive();
    if (this.#content.promoteVisible(id)) this.schedule();
  }
  public instrumentation(): SceneInstrumentationSnapshot {
    this.refreshCacheInstrumentation();
    this.#motion.refreshInstrumentation();
    return snapshotInstrumentation(this.#instrumentation);
  }
  public resetInstrumentation(): void {
    resetInstrumentation(this.#instrumentation);
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
    this.invalidateVisibility();
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
    const deadline = startedAt + validateFrameBudget(this.#frameBudgetMs());
    this.performReadPhase();
    if (this.#previewCommits.releaseCommitted()) {
      this.#content.materializePreviewGeometry(this.#transformPreviews.values);
      this.#transformPreviews.clear();
      this.#elementPreviews.clear();
      this.reconcileReleasedPreviewVisibility();
    }
    this.prepareVisibility();
    this.#transformPreviews.refreshContext();
    this.flushPointerFeedbackFrame();
    const pendingMountedChanges = this.#content.writeMountedChanges(deadline, () =>
      this.#scheduler.now(),
    );
    if (pendingMountedChanges) {
      this.schedule();
      this.refreshCacheInstrumentation();
      this.#resourcePolicy.notifyUsageChanged();
      return;
    }
    const pendingVisibility = this.#content.reconcileVisibility(
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
    const mountedIds = this.#content.takeNewlyMountedIds();
    this.#motion.bindMountedEntrances(mountedIds);
    this.#motion.finishEntranceBatch();
    this.#elementPreviews.applyMounted(mountedIds);
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
    if (backgroundDeferred || pendingMotion || overBudget) this.schedule();
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
    validateViewport(viewport);
    if (!sameViewport(this.#viewport, viewport)) {
      this.#viewport = viewport;
      this.#transformPreviews.setContext(this.#camera, viewport);
      this.invalidateVisibility();
    }
    this.#layoutDirty = false;
  }
  private prepareVisibility(): void {
    if (this.#viewport === undefined) return;
    if (!this.#visibilityDirty) {
      if (this.#orderVisibilityDirty) {
        this.#orderVisibilityDirty = false;
        const visibility = this.#visibility.resortCurrent();
        this.#content.replaceVisibility(visibility);
        this.#resourcePolicy.updateVisibility(visibility);
      }
      return;
    }
    const { envelope, retained } = visibilityPageBounds(this.#viewport, this.#camera);
    this.#visibilityDirty = false;
    this.#orderVisibilityDirty = false;
    const result = this.#visibility.query(envelope, retained);
    if (!result.changed) return;
    const { visibility } = result;
    this.#content.replaceVisibility(visibility);
    this.#resourcePolicy.updateVisibility(visibility);
  }
  private invalidateVisibility(): void {
    this.#visibilityDirty = true;
    this.#content.cancelPendingVisibility();
  }
  private reconcileReleasedPreviewVisibility(): void {
    this.invalidateVisibility();
    this.#content.replaceVisibility(this.#visibility.resortCurrent());
  }
  private refreshCacheInstrumentation(): void {
    refreshCacheInstrumentation(this.#instrumentation, this.#backgroundCache, this.#pathCache);
  }
  private assertActive(): void {
    if (this.#disposed) throw new Error("The SVG scene renderer has been destroyed.");
  }
}
