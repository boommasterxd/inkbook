import { SceneGeometryPublication } from "./content/geometry-publication";
import { SceneSelectionRuns } from "./presentation/selection-runs";
import type { ProgressivePreviewTransform } from "./presentation/progressive-preview-request";
import type { RenderBand } from "../../domain/commands/render-bands";
import type { Bounds } from "../../domain/geometry/primitives";
import type { SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { setMountedElementMotion, type MountedSceneElement } from "./content/mounted-element";
import type { ScenePathCache } from "./content/path-cache";
import type { ScenePublicationBudget } from "./reconciliation/mount-slice";
import { SceneElementFades, type FadeSlice } from "./presentation/scene-element-fades";
import { setHistoryFadeGate, type ElementFadeDirection } from "./presentation/element-fade-style";
import { SceneSelectionTraces } from "./presentation/selection-traces";
import type { SceneDom } from "./scene-dom";
import type { MutableSceneInstrumentation, SceneStorePort, SceneDeltaEntry } from "./types";
import type { SceneVisibilityState } from "./visibility/visibility-state";
import { SceneVisibilityReconciler } from "./reconciliation/scene-visibility-reconciler";
import type { PreviewTransform } from "./reconciliation/scene-visibility-reconciler";
import { markSceneOrderDirty } from "./content/dirty-set-work";
import { commitVisibleBands, mountedVisibleIds } from "./visibility/visibility-order";
import { mountedPreviewIds } from "./presentation/preview-transform-selection";
import type { PreviewMembershipContext } from "./types";
import type { ScenePreparationOptions } from "./reconciliation/reconciliation-state";
type ContentOptions = ScenePreparationOptions & {
  readonly zoom?: () => number;
};
import type { SceneVisibilityPriority } from "./visibility/scene-entrant-priority";
const EMPTY_IDS: readonly string[] = Object.freeze([]);

export class SceneContentRenderer {
  readonly #dom: SceneDom;
  readonly #committedIds: Record<RenderBand, readonly (string | undefined)[]> = {
    content: [],
    highlight: [],
  };
  readonly #committedCounts: Record<RenderBand, number> = {
    content: 0,
    highlight: 0,
  };
  readonly #mounted = new Map<string, MountedSceneElement>();
  readonly #fades = new SceneElementFades(
    this.#mounted,
    (id, finish) => this.#reconciler.updateExitReadiness(id, finish),
    (generation, interrupted) => setHistoryFadeGate(this.#dom.svg, generation, interrupted),
  );
  #newlyMountedIds: readonly string[] = EMPTY_IDS;
  readonly #orderDirty: Record<RenderBand, Set<string>> = {
    content: new Set(),
    highlight: new Set(),
  };
  readonly #reconciler: SceneVisibilityReconciler;
  readonly #store: SceneStorePort;
  readonly #visibility: SceneVisibilityState;
  readonly #selectionTraces: SceneSelectionTraces;
  readonly #selectionRuns: SceneSelectionRuns;
  readonly #publication: SceneGeometryPublication;
  readonly #detachedCache: ContentOptions["detachedCache"];
  public constructor(
    dom: SceneDom,
    store: SceneStorePort,
    visibility: SceneVisibilityState,
    pathCache: ScenePathCache,
    instrumentation: MutableSceneInstrumentation,
    options: ContentOptions = {},
  ) {
    this.#dom = dom;
    this.#detachedCache = options.detachedCache;
    this.#selectionTraces = new SceneSelectionTraces(
      dom.selectionTraceGroup,
      instrumentation,
      dom.selectionOverlayPath,
      (entry) => this.#selectionRuns.bindTrace(entry),
    );
    this.#selectionRuns = new SceneSelectionRuns({
      dom,
      mounted: this.#mounted,
      store,
      instrumentation,
      trace: (id) => this.#selectionTraces.node(id),
      zoom: options.zoom ?? (() => 1),
      visible: (id) => this.#visibility.contains(id),
      syncTrace: (entry) => this.#selectionTraces.transform(entry.id, entry),
    });
    this.#publication = new SceneGeometryPublication({
      dom,
      mounted: this.#mounted,
      store,
      pathCache,
      instrumentation,
      selectionRuns: this.#selectionRuns,
      selectionTraces: this.#selectionTraces,
    });
    this.#store = store;
    this.#visibility = visibility;
    this.#reconciler = new SceneVisibilityReconciler({
      ...options,
      dom,
      instrumentation,
      isExitReady: (id, now) => this.#fades.isExitReady(id, now),
      exitReadyAt: (id) => this.#fades.readyAt(id),
      mounted: this.#mounted,
      onMount: (entry) => {
        this.#fades.bindMounted(entry);
        this.#selectionRuns.mounted(entry);
      },
      onUnmount: (id) => {
        this.#fades.releaseMounted(id);
        this.#selectionRuns.unmounted(id);
      },
      onRetain: (entry) => this.#publication.retain(entry),
      placement: this.#selectionRuns.groups,
      orderDirty: this.#orderDirty,
      pathCache,
      store,
      visibility,
    });
  }
  public setSelectedElements(ids: ReadonlySet<string>): void {
    this.#selectionRuns.setSelection(ids);
    if (this.#selectionTraces.setSelection(ids)) this.#publication.markSelectionDirty();
  }
  public refreshSelectionFeedbackZoom(): void {
    this.#selectionRuns.refreshZoom();
  }
  public get hasSharedSelectionCommitFeedback(): boolean {
    return this.#selectionRuns.hasRetainableFeedback;
  }
  public get hasRunCommitOwnership(): boolean {
    return this.#selectionRuns.committing;
  }
  public stageSelectionFeedback(feedback: ProgressivePreviewTransform | undefined): void {
    this.#selectionRuns.stage(feedback);
  }
  public setSelectionHighlightsEnabled(enabled: boolean): void {
    if (this.#selectionTraces.setHighlightsEnabled(enabled)) this.#publication.markSelectionDirty();
  }
  public flushSelectionContext(): void {
    this.#selectionTraces.flushContext();
  }
  public previewMemoryUsage(): number {
    return (
      // Reserve one six-coefficient preview matrix per mounted entry, including aliases.
      this.#mounted.size * 6 * 8 +
      this.#selectionTraces.memoryUsage() +
      this.#selectionRuns.memoryUsage() +
      this.#publication.memoryUsage() +
      this.#reconciler.memoryUsage() +
      this.#fades.memoryUsage()
    );
  }
  public get mountedCount(): number {
    return this.#mounted.size;
  }
  public previewMountedIds(context?: PreviewMembershipContext): Iterable<string> {
    return mountedPreviewIds(this.#mounted, this.#visibility, context);
  }
  public hasMounted(id: string): boolean {
    return this.#mounted.has(id);
  }
  public mountedIds(band: RenderBand): readonly string[] {
    return mountedVisibleIds(this.#committedIds[band], this.#committedCounts[band], this.#mounted);
  }
  public takeNewlyMountedIds(): readonly string[] {
    if (this.#newlyMountedIds.length === 0) return EMPTY_IDS;
    const ids = this.#newlyMountedIds;
    this.#newlyMountedIds = EMPTY_IDS;
    return ids;
  }
  public markGeometry(id: string, change?: SceneDeltaEntry): void {
    this.#publication.markGeometry(id, change);
  }
  public markPaint(id: string): void {
    this.#publication.markPaint(id);
  }
  public finishGeometryDelta(geometryOnly: boolean): void {
    this.#selectionRuns.finishDelta(geometryOnly);
  }
  public markOrders(ids: readonly string[]): void {
    this.#selectionRuns.invalidate();
    for (const id of ids) {
      markSceneOrderDirty(id, this.#store, this.#orderDirty, this.#detachedCache);
    }
    this.#reconciler.cancel();
  }
  public materializePreviewGeometry(
    previews: ReadonlyMap<string, PreviewTransform>,
    elements: ReadonlyMap<string, InkElementV1>,
  ): void {
    this.#publication.materializePreviewGeometry(previews, elements);
  }
  public takeCommittedPreviewIds(): readonly string[] {
    return this.#publication.takeCommittedPreviewIds();
  }
  public writeMountedChanges(
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
    admittedFirstStep = false,
  ): boolean {
    return this.#publication.writeMountedChanges(deadline, now, publication, admittedFirstStep);
  }
  public get hasPendingExitCleanup(): boolean {
    return this.#reconciler.hasPendingCleanup;
  }
  public get hasMountedWork(): boolean {
    return this.#publication.hasMountedWork;
  }
  public get hasVisibilityWork(): boolean {
    return this.#reconciler.hasPendingWork;
  }
  public get hasPendingViewportWork(): boolean {
    return this.hasMountedWork || this.#reconciler.hasPendingViewportWork;
  }
  public get waitingForPaths(): boolean {
    return this.#reconciler.waitingForPaths && !this.hasMountedWork;
  }
  public setVisibilityPriority(priority: SceneVisibilityPriority): void {
    this.#reconciler.setPriority(priority);
  }
  public hasUnprotectedDeferredExit(
    ...args: Parameters<SceneVisibilityReconciler["hasUnprotectedDeferredExit"]>
  ): boolean {
    return this.#reconciler.hasUnprotectedDeferredExit(...args);
  }
  public get hasPendingWork(): boolean {
    return this.hasMountedWork || this.hasVisibilityWork;
  }
  public get needsVisibilityRestart(): boolean {
    return this.#reconciler.needsRestart;
  }
  public replaceVisibility(...args: Parameters<SceneVisibilityReconciler["replace"]>): void {
    this.#reconciler.replace(...args);
  }
  public cancelPendingVisibility(): void {
    this.#reconciler.cancel();
  }
  public reconcileVisibility(
    deadline: number,
    now: () => number,
    previewTransforms: ReadonlyMap<string, PreviewTransform>,
    previewElements: ReadonlyMap<string, InkElementV1>,
    publication: ScenePublicationBudget,
  ): boolean {
    const wasCleaning = this.#reconciler.hasPendingCleanup;
    const result = this.#reconciler.reconcile(
      deadline,
      now,
      previewTransforms,
      previewElements,
      publication,
    );
    if (wasCleaning && !this.#reconciler.hasPendingCleanup) {
      this.#selectionTraces.prune(this.#mounted);
    }
    if (result.committedVisibility !== undefined) {
      commitVisibleBands(
        this.#committedIds,
        this.#committedCounts,
        result.committedVisibility,
        result.orderProofEpoch === undefined
          ? undefined
          : {
              mounted: this.#mounted,
              store: this.#store,
              epoch: result.orderProofEpoch,
            },
        result.pending ? undefined : this.#visibility.removalReuse,
      );
      this.#selectionTraces.prune(this.#mounted);
    }
    this.#newlyMountedIds = result.newlyMountedIds;
    this.#publication.markSelectionDirty(result.newlyMountedIds);
    return result.pending || this.#publication.hasSelectionWork;
  }
  public promoteVisible(id: string): boolean {
    return this.#reconciler.promote(id);
  }
  public applyPreviewTransform(
    id: string,
    transform: string | null,
    version: number,
    strokeWidthScale: number | null,
    matrix?: PreviewTransform["matrix"],
  ): void {
    this.#publication.applyPreviewTransform(id, transform, version, strokeWidthScale, matrix);
  }
  public applyElementPreview(element: InkElementV1): boolean {
    return this.#publication.applyElementPreview(element);
  }
  public readCanonicalStrokePath(element: InkElementV1): readonly SvgPathPart[] | undefined {
    return this.#publication.readCanonicalStrokePath(element);
  }
  public applyCanonicalElementPreview(
    element: InkElementV1,
    parts: readonly SvgPathPart[],
  ): boolean {
    return this.#publication.applyCanonicalElementPreview(element, parts);
  }
  public clearElementPreview(id: string): void {
    this.#publication.clearElementPreview(id);
  }
  public setElementFade(
    ids: readonly string[],
    durationMs: number | null,
    slice?: FadeSlice,
  ): void {
    this.#fades.set(ids, durationMs, slice);
  }
  public prepareElementRemoval(id: string): void {
    if (this.#mounted.get(id)?.fadeActive !== true && this.#fades.readyAt(id) === 0)
      this.#fades.set([id], 0);
  }
  public setMembershipViewport(bounds: Bounds | undefined): void {
    this.#fades.setViewport(bounds);
  }
  public setMembershipFade(
    id: string,
    direction: ElementFadeDirection,
    durationMs: number,
    bounds?: Bounds,
  ): void {
    this.#fades.setMembership(id, direction, durationMs, bounds ?? this.#store.get(id)?.bounds);
  }
  public settleMembershipVisibility(contains: (id: string) => boolean): void {
    this.#fades.settleVisibility(contains);
  }
  public interruptMembershipFades(): void {
    this.#fades.interruptMembership();
    this.#reconciler.invalidateExitReadiness();
  }
  public setReducedMotion(reduced: boolean): void {
    this.#fades.setReducedMotion(reduced);
    if (reduced) this.interruptMembershipFades();
  }
  public get pendingElementFades(): boolean {
    return this.#fades.pending;
  }
  public flushElementFades(deadline: number, now: () => number): boolean {
    return this.#fades.flush(deadline, now);
  }
  public setElementMotion(ids: readonly string[], opacity: number | null, scale = 1): void {
    for (const id of ids) {
      const entry = this.#mounted.get(id);
      if (entry !== undefined) setMountedElementMotion(entry, opacity, scale);
    }
  }
  public release(): void {
    this.#selectionRuns.release();
    this.#publication.release();
    this.#fades.release();
    this.#selectionTraces.release();
    this.#reconciler.release();
    this.#orderDirty.content.clear();
    this.#orderDirty.highlight.clear();
    this.#mounted.clear();
    this.#detachedCache?.dispose();
    this.#newlyMountedIds = EMPTY_IDS;
    this.#committedIds.content = [];
    this.#committedIds.highlight = [];
    this.#committedCounts.content = 0;
    this.#committedCounts.highlight = 0;
  }
  public selectionFeedbackIds(
    feedback: ProgressivePreviewTransform | undefined,
  ): readonly string[] | undefined {
    return this.#selectionRuns.ids(feedback);
  }
  public selectionFeedbackSnapshotIds(
    feedback: ProgressivePreviewTransform | undefined,
  ): readonly string[] | undefined {
    return this.#selectionRuns.snapshotIds(feedback);
  }
  public canUseSelectionFeedback(feedback: ProgressivePreviewTransform | undefined): boolean {
    return this.#selectionRuns.canUse(feedback);
  }
  public selectionFeedbackExceptionIds(
    feedback: ProgressivePreviewTransform | undefined,
  ): readonly string[] | undefined {
    return this.#selectionRuns.exceptionIds(feedback);
  }
  public publishSelectionFeedback(feedback: ProgressivePreviewTransform, version: number): boolean {
    return this.#selectionRuns.publish(feedback, version);
  }
  public setSelectionFeedbackBasis(
    id: string,
    basis: ProgressivePreviewTransform | undefined,
  ): void {
    this.#selectionRuns.basis(id, basis);
  }
  public clearSelectionFeedback(): void {
    this.#selectionRuns.clear();
  }
  public get selectionFeedbackTransforms(): ReadonlyMap<string, PreviewTransform> {
    return this.#selectionRuns.transforms;
  }
  public get deferVisibilityForRunCommit(): boolean {
    return (
      this.#selectionRuns.structuralRetirement ||
      (this.#selectionRuns.cleaning && !this.#selectionRuns.active)
    );
  }
}
