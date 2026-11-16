import { SceneGeometryPublication } from "./content/geometry-publication";
import { TextViewportPublication } from "./content/text-viewport-publication";
import { SceneSelectionRuns } from "./presentation/selection-runs";
import { RunTranslationAdmission } from "./presentation/selection-translation-admission";
import type { ProgressivePreviewTransform } from "./presentation/progressive-preview-request";
import type { RenderBand } from "../../domain/commands/render-bands";
import type { Bounds } from "../../domain/geometry/primitives";
import type { SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { setMountedElementMotion, type MountedSceneElement } from "./content/mounted-element";
import type { ScenePathCache } from "./content/path-cache";
import { MountSlice, type ScenePublicationBudget } from "./reconciliation/mount-slice";
import { SceneElementFades, type FadeSlice } from "./presentation/scene-element-fades";
import { setHistoryFadeGate, type ElementFadeDirection } from "./presentation/element-fade-style";
import { SceneSelectionTraces } from "./presentation/selection-traces";
import type { SceneDom } from "./scene-dom";
import type { MutableSceneInstrumentation, SceneStorePort, SceneDeltaEntry } from "./types";
import type { SceneVisibilityState } from "./visibility/visibility-state";
import { SceneVisibilityReconciler } from "./reconciliation/scene-visibility-reconciler";
import type { PreviewTransform } from "./reconciliation/scene-visibility-reconciler";
import { markSceneOrderDirty, resetSceneBands } from "./content/dirty-set-work";
import { commitVisibleBands, mountedVisibleIds } from "./visibility/visibility-order";
import { mountedPreviewIds } from "./presentation/preview-transform-selection";
import type { PreviewMembershipContext } from "./types";
import type { ScenePreparationOptions } from "./reconciliation/reconciliation-state";
type ContentOptions = ScenePreparationOptions & {
  readonly canPrepareGeometry?: () => boolean;
  readonly zoom?: () => number;
};
type CanonicalPreviewArguments = Parameters<
  SceneGeometryPublication["applyCanonicalElementPreview"]
>;
import type { SceneVisibilityPriority } from "./visibility/scene-entrant-priority";
const EMPTY_IDS: readonly string[] = Object.freeze([]);
export class SceneContentRenderer {
  public readonly selectionTranslation: RunTranslationAdmission;
  public readonly selectionFeedbackIds: SceneSelectionRuns["ids"];
  public onTextElementStateChanged: (id: string, state: "published" | "removed") => void = () =>
    undefined;
  #pinnedTextId: string | undefined;
  readonly #dom: SceneDom;
  readonly #committedIds: Record<RenderBand, readonly (string | undefined)[]> = {
    image: [],
    content: [],
    highlight: [],
  };
  readonly #committedCounts: Record<RenderBand, number> = {
    image: 0,
    content: 0,
    highlight: 0,
  };
  readonly #mounted = new Map<string, MountedSceneElement>();
  readonly #textViewport = new TextViewportPublication(this.#mounted, (id) =>
    this.#selectionRuns.transforms.get(id),
  );
  readonly #fades = new SceneElementFades(
    this.#mounted,
    (id, finish) => this.#reconciler.updateExitReadiness(id, finish),
    (generation, interrupted) => setHistoryFadeGate(this.#dom.svg, generation, interrupted),
  );
  #newlyMountedIds: readonly string[] = EMPTY_IDS;
  readonly #orderDirty: Record<RenderBand, Set<string>> = {
    image: new Set(),
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
    this.selectionFeedbackIds = this.#selectionRuns.ids.bind(this.#selectionRuns);
    let waitingForGeometryAdmission = false;
    this.#publication = new SceneGeometryPublication({
      prepareGeometry: (record, deadline, now, preemptLocal) => {
        if (
          !preemptLocal &&
          (!this.#visibility.contains(record.id) || options.canPrepareGeometry?.() === false)
        ) {
          waitingForGeometryAdmission = true;
          this.#reconciler.preparation.pauseLocal(record.id);
          return undefined;
        }
        waitingForGeometryAdmission = false;
        return this.#reconciler.preparation.prepare(
          record,
          new MountSlice(deadline, now),
          true,
          preemptLocal,
        );
      },
      waitingForPaths: () => waitingForGeometryAdmission || this.#reconciler.preparation.waiting,
      releaseGeometry: (id, version) => this.#reconciler.preparation.finish(id, version),
      dom,
      mounted: this.#mounted,
      store,
      pathCache,
      instrumentation,
      selectionRuns: this.#selectionRuns,
      selectionTraces: this.#selectionTraces,
      onTextPublished: (id) => this.onTextElementStateChanged(id, "published"),
    });
    this.selectionTranslation = new RunTranslationAdmission(this.#selectionRuns, this.#publication);
    this.#store = store;
    this.#visibility = visibility;
    this.#reconciler = new SceneVisibilityReconciler({
      ...options,
      textViewport: this.#textViewport.localBounds,
      upcomingGeometryIds: () => this.#publication.upcomingGeometryIds(),
      retainGeometryPath: (id) => this.#publication.retainsGeometryPath(id),
      dom,
      instrumentation,
      isExitReady: (id, now) => this.#fades.isExitReady(id, now),
      exitReadyAt: (id) => this.#fades.readyAt(id),
      mounted: this.#mounted,
      onMount: (entry) => {
        this.#textViewport.mount(entry);
        this.#fades.bindMounted(entry);
        this.#selectionRuns.mounted(entry);
        if (entry.text !== undefined) this.onTextElementStateChanged(entry.id, "published");
      },
      onUnmount: (id) => {
        this.#textViewport.remove(id);
        this.onTextElementStateChanged(id, "removed");
        this.#publication.unmounted(id);
        this.#reconciler.preparation.release(id, true);
        this.#fades.releaseMounted(id);
        this.#selectionRuns.unmounted(id);
      },
      onRetain: (entry) => this.#publication.retain(entry),
      placement: this.#selectionRuns.groups,
      orderDirty: this.#orderDirty,
      pathCache,
      store,
      visibility,
      isPinned: (id) => this.#pinnedTextId === id && this.#store.get(id) !== undefined,
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
      this.#mounted.size * (6 * 8 + 40) +
      this.#selectionTraces.memoryUsage() +
      this.#selectionRuns.memoryUsage() +
      this.#publication.memoryUsage() +
      this.#reconciler.memoryUsage() +
      this.#fades.memoryUsage() +
      this.#textViewport.memoryUsage()
    );
  }
  public get mountedCount(): number {
    return this.#mounted.size;
  }
  public previewMountedIds(context?: PreviewMembershipContext): Iterable<string> {
    return mountedPreviewIds(this.#mounted, this.#visibility, context);
  }
  public readonly hasMounted = (id: string): boolean => this.#mounted.has(id);
  public mountedText(id: string) {
    return this.#mounted.get(id)?.text;
  }
  public mountedImageRoot(id: string): SVGGElement | undefined {
    return this.#mounted.get(id)?.image?.group;
  }
  public readonly mountedBounds = (id: string): Bounds | undefined => this.#mounted.get(id)?.bounds;
  public textMotionSnapshot(element: InkElementV1, maximumNodes: number, maximumBytes: number) {
    return element.kind === "text"
      ? this.#mounted.get(element.id)?.text?.motionSnapshot(element, maximumNodes, maximumBytes)
      : undefined;
  }
  public textReady(id: string): boolean {
    const entry = this.#mounted.get(id);
    const record = this.#store.get(id);
    return (
      record?.element.kind === "text" &&
      entry?.text?.element === record.element &&
      entry.geometryVersion === record.geometryVersion &&
      entry.paintVersion === record.paintVersion
    );
  }
  public pinText(id: string | undefined): void {
    this.#pinnedTextId = id;
    this.#visibility.removalReuse.invalidate();
    if (id === undefined) this.#reconciler.replace(this.#visibility.resortCurrent());
    this.#dom.onSurfaceInvalidated();
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
    this.#textViewport.invalidate(id);
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
    ...args: Parameters<SceneGeometryPublication["writeMountedChanges"]>
  ): boolean {
    const pending = this.#publication.writeMountedChanges(...args);
    return this.#textViewport.write(args[0], args[1]) || pending;
  }
  public get hasPendingExitCleanup(): boolean {
    return this.#reconciler.hasPendingCleanup;
  }
  public get hasMountedWork(): boolean {
    return this.#publication.hasMountedWork || this.#textViewport.pending;
  }
  public get hasGeometryWork(): boolean {
    return this.#publication.hasGeometryWork;
  }
  public get hasVisibilityWork(): boolean {
    return this.#reconciler.hasPendingWork;
  }
  public get hasPendingViewportWork(): boolean {
    return this.hasMountedWork || this.#reconciler.hasPendingViewportWork;
  }
  public get waitingForPaths(): boolean {
    if (this.#textViewport.pending) return false;
    return (
      (this.deferVisibilityForRunCommit ||
        this.#reconciler.waitingForPaths ||
        !this.hasVisibilityWork) &&
      (this.#publication.waitingForPaths || !this.hasMountedWork) &&
      this.hasPendingWork
    );
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
    try {
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
    } finally {
      this.#reconciler.preparation.flushRetargets();
    }
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
    textBasis?: PreviewTransform["textBasis"],
  ): void {
    this.#textViewport.invalidate(id);
    this.#publication.applyPreviewTransform(
      id,
      transform,
      version,
      strokeWidthScale,
      matrix,
      textBasis,
    );
  }
  public applyElementPreview(element: InkElementV1): boolean {
    return this.#publication.applyElementPreview(element);
  }
  public get hasPendingTextPreviews(): boolean {
    return this.#publication.hasPendingTextPreviews;
  }
  public readCanonicalStrokePath(element: InkElementV1): readonly SvgPathPart[] | undefined {
    return this.#publication.readCanonicalStrokePath(element);
  }
  public applyCanonicalElementPreview(...args: CanonicalPreviewArguments): boolean {
    return this.#publication.applyCanonicalElementPreview(...args);
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
    this.onTextElementStateChanged(id, "removed");
    if (this.#mounted.get(id)?.fadeActive !== true && this.#fades.readyAt(id) === 0)
      this.#fades.set([id], 0);
  }
  public setMembershipViewport(bounds: Bounds | undefined): void {
    this.#textViewport.set(bounds);
    this.#fades.setViewport(bounds);
  }
  public setMembershipFade(
    id: string,
    direction: ElementFadeDirection,
    durationMs: number,
    bounds?: Bounds,
  ): void {
    if (direction === "exit" && this.#store.get(id) === undefined)
      this.onTextElementStateChanged(id, "removed");
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
      this.#textViewport.invalidate(id);
      const entry = this.#mounted.get(id);
      if (entry !== undefined) setMountedElementMotion(entry, opacity, scale);
    }
  }
  public release(): void {
    this.#textViewport.release();
    this.#selectionRuns.release();
    this.#publication.release();
    this.#fades.release();
    this.#selectionTraces.release();
    this.#reconciler.release();
    resetSceneBands(this.#orderDirty, this.#committedIds, this.#committedCounts);
    this.#mounted.clear();
    this.#detachedCache?.dispose();
    this.#newlyMountedIds = EMPTY_IDS;
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
    this.#textViewport.refresh();
    return this.#selectionRuns.publish(feedback, version);
  }
  public setSelectionFeedbackBasis(
    id: string,
    basis: ProgressivePreviewTransform | undefined,
  ): void {
    this.#selectionRuns.basis(id, basis);
  }
  public clearSelectionFeedback(): void {
    this.#textViewport.refresh();
    this.#selectionRuns.clear();
  }
  public get selectionFeedbackTransforms(): ReadonlyMap<string, PreviewTransform> {
    return this.#selectionRuns.transforms;
  }
  public get deferVisibilityForRunCommit(): boolean {
    return this.#selectionRuns.defersVisibility;
  }
}
