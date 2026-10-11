import { strokeLocalGeometry } from "../../domain/geometry/stroke-position";
import { isStoredStroke } from "../../domain/elements/stroke-replacement-proof";
import { sameStrokeShape } from "./stroke-position";
import { CommittedPreviewGeometry } from "./committed-preview-geometry";
import type { RenderBand } from "../../domain/commands/render-bands";
import type { Bounds } from "../../domain/geometry/primitives";
import { buildElementPathParts, type SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import {
  updateMountedGeometry,
  updateMountedElementPreview,
  updateMountedPaint,
  updatePreviewTransform,
  setMountedElementMotion,
  type MountedSceneElement,
} from "./mounted-element";
import type { ScenePathCache } from "./path-cache";
import type { ScenePublicationBudget } from "./mount-slice";
import { SceneElementFades, type FadeSlice } from "./scene-element-fades";
import { setHistoryFadeGate, type ElementFadeDirection } from "./element-fade-style";
import { SceneSelectionTraces } from "./selection-traces";
import type { SceneDom } from "./scene-dom";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";
import type { SceneVisibilityState, VisibilityResult } from "./visibility-state";
import { SceneVisibilityReconciler, type PreviewTransform } from "./scene-visibility-reconciler";
import { markSceneOrderDirty, writeDirtySet } from "./dirty-set-work";
import { commitVisibleBands, mountedVisibleIds } from "./visibility-order";
import type { ScenePreparationOptions as ContentOptions } from "./reconciliation-state";
import type { SceneVisibilityPriority } from "./scene-entrant-priority";

const EMPTY_IDS: readonly string[] = Object.freeze([]);

export class SceneContentRenderer {
  readonly #dom: SceneDom;
  readonly #committedIds: Record<RenderBand, readonly (string | undefined)[]> = {
    content: [],
    highlight: [],
  };
  readonly #committedCounts: Record<RenderBand, number> = { content: 0, highlight: 0 };
  readonly #geometryDirty = new Set<string>();
  readonly #committedGeometry = new CommittedPreviewGeometry();
  readonly #deferredPreviews = new Set<string>();
  #committedPreviewIds: string[] = [];
  readonly #instrumentation: MutableSceneInstrumentation;
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
  readonly #paintDirty = new Set<string>();
  readonly #pathCache: ScenePathCache;
  readonly #reconciler: SceneVisibilityReconciler;
  readonly #store: SceneStorePort;
  readonly #selectionTraces: SceneSelectionTraces;
  readonly #selectionDirty = new Set<string>();
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
    );
    this.#store = store;
    this.#pathCache = pathCache;
    this.#instrumentation = instrumentation;
    this.#reconciler = new SceneVisibilityReconciler({
      ...options,
      dom,
      instrumentation,
      isExitReady: (id, now) => this.#fades.isExitReady(id, now),
      exitReadyAt: (id) => this.#fades.readyAt(id),
      mounted: this.#mounted,
      onMount: (entry) => this.#fades.bindMounted(entry),
      onUnmount: (id) => this.#fades.releaseMounted(id),
      orderDirty: this.#orderDirty,
      pathCache,
      store,
      visibility,
    });
  }
  public setSelectedElements(ids: ReadonlySet<string>): void {
    if (this.#selectionTraces.setSelection(ids))
      this.#selectionTraces.markMountedDirty(this.#mounted, this.#selectionDirty);
  }
  public setSelectionHighlightsEnabled(enabled: boolean): void {
    if (this.#selectionTraces.setHighlightsEnabled(enabled))
      this.#selectionTraces.markMountedDirty(this.#mounted, this.#selectionDirty);
  }
  public flushSelectionContext(): void {
    this.#selectionTraces.flushContext();
  }
  public previewMemoryUsage(): number {
    return (
      this.#selectionTraces.memoryUsage() +
      this.#committedGeometry.memoryUsage() +
      this.#reconciler.memoryUsage() +
      this.#fades.memoryUsage() +
      (this.#deferredPreviews.size + this.#committedPreviewIds.length) * 8
    );
  }
  public get mountedCount(): number {
    return this.#mounted.size;
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
  public markGeometry(id: string): void {
    if (this.#mounted.has(id)) this.#geometryDirty.add(id);
    this.#pathCache.invalidate(id);
  }
  public markPaint(id: string): void {
    this.#paintDirty.add(id);
  }
  public markOrder(id: string): void {
    this.markOrders([id]);
  }
  public markOrders(ids: readonly string[]): void {
    for (const id of ids) {
      markSceneOrderDirty(id, this.#store, this.#orderDirty, this.#detachedCache);
    }
    this.#reconciler.cancel();
  }

  public materializePreviewGeometry(
    previews: ReadonlyMap<string, PreviewTransform>,
    elements: ReadonlyMap<string, InkElementV1>,
  ): void {
    this.#committedGeometry.retainPreviews(previews, elements, {
      dirty: this.#geometryDirty,
      mounted: this.#mounted,
    });
  }

  public takeCommittedPreviewIds(): readonly string[] {
    if (this.#committedPreviewIds.length === 0) return EMPTY_IDS;
    const ids = this.#committedPreviewIds;
    this.#committedPreviewIds = [];
    return ids;
  }

  public writeMountedChanges(
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): boolean {
    if (this.#geometryDirty.size > 0) {
      if (
        writeDirtySet(this.#geometryDirty, deadline, now, (id) =>
          this.writeGeometry(id, deadline, now, publication),
        )
      )
        return true;
      if (now() >= deadline) return this.#paintDirty.size > 0 || this.#selectionDirty.size > 0;
    }
    if (this.#paintDirty.size > 0) {
      if (writeDirtySet(this.#paintDirty, deadline, now, (id) => this.writePaint(id, publication)))
        return true;
      if (now() >= deadline) return this.#selectionDirty.size > 0;
    }
    return this.#selectionTraces.writeDirty(
      this.#selectionDirty,
      this.#mounted,
      this.#store,
      deadline,
      now,
      publication,
    );
  }
  public get hasPendingExitCleanup(): boolean {
    return this.#reconciler.hasPendingCleanup;
  }
  public get hasMountedWork(): boolean {
    return (
      this.#geometryDirty.size > 0 || this.#paintDirty.size > 0 || this.#selectionDirty.size > 0
    );
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
      this.commitVisibility(result.committedVisibility, result.orderProofEpoch);
      this.#selectionTraces.prune(this.#mounted);
    }
    this.#newlyMountedIds = result.newlyMountedIds;
    this.#selectionTraces.markMountedDirty(
      this.#mounted,
      this.#selectionDirty,
      result.newlyMountedIds,
    );
    return result.pending || this.#selectionDirty.size > 0;
  }
  public promoteVisible(id: string): boolean {
    return this.#reconciler.promote(id);
  }

  public applyPreviewTransform(
    id: string,
    transform: string | null,
    version: number,
    strokeWidthScale: number | null,
  ): void {
    const entry = this.#mounted.get(id);
    if (entry !== undefined) {
      const resolved = this.#committedGeometry.resolve(id, {
        transform,
        version,
        strokeWidthScale,
      });
      updatePreviewTransform(
        entry,
        resolved.transform,
        resolved.version,
        resolved.strokeWidthScale,
        this.#instrumentation,
      );
      this.#selectionTraces.transform(id, entry);
    }
  }

  public applyElementPreview(element: InkElementV1): boolean {
    if (this.#committedGeometry.has(element.id)) {
      this.#deferredPreviews.add(element.id);
      return false;
    }
    const entry = this.#mounted.get(element.id);
    const parts =
      entry !== undefined && sameStrokeShape(entry.displayedElement, element)
        ? entry.displayedPathParts
        : buildElementPathParts(element.kind === "stroke" ? strokeLocalGeometry(element) : element);
    return this.applyCanonicalElementPreview(element, parts);
  }
  public readCanonicalStrokePath(element: InkElementV1): readonly SvgPathPart[] | undefined {
    const entry = this.#mounted.get(element.id);
    return element.kind === "stroke" &&
      (Object.isFrozen(element.points) || isStoredStroke(element)) &&
      entry !== undefined &&
      sameStrokeShape(entry.displayedElement, element)
      ? entry.displayedPathParts
      : undefined;
  }
  public applyCanonicalElementPreview(
    element: InkElementV1,
    parts: readonly SvgPathPart[],
  ): boolean {
    if (this.#committedGeometry.has(element.id)) {
      this.#deferredPreviews.add(element.id);
      return false;
    }
    const entry = this.#mounted.get(element.id);
    const record = this.#store.get(element.id);
    if (entry === undefined || record === undefined) return false;
    updateMountedElementPreview(entry, record, element, parts, {
      instrumentation: this.#instrumentation,
      ownerDocument: this.#dom.ownerDocument,
      parent: this.#dom.group(entry.band),
    });
    if (this.#selectionTraces.update(entry, element, parts))
      this.#selectionDirty.delete(element.id);
    else this.#selectionDirty.add(element.id);
    return true;
  }

  public clearElementPreview(id: string): void {
    if (this.#committedGeometry.has(id)) {
      this.#geometryDirty.add(id);
      return;
    }
    const entry = this.#mounted.get(id);
    const record = this.#store.get(id);
    if (entry === undefined || record === undefined) return;
    if (
      entry.geometryVersion !== record.geometryVersion &&
      record.element.kind === "stroke" &&
      record.element.style.pressureEnabled
    ) {
      this.#geometryDirty.add(id);
      return;
    }
    const parts =
      entry.geometryVersion === record.geometryVersion
        ? entry.pathParts
        : this.#pathCache.build(
            record.element,
            this.#store.pressureGeometry?.(record.id, record.geometryVersion),
          );
    this.updateGeometry(entry, record, parts);
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
    this.#committedGeometry.release();
    this.#deferredPreviews.clear();
    this.#committedPreviewIds = [];
    this.#fades.release();
    this.#selectionTraces.release();
    this.#selectionDirty.clear();
    this.#reconciler.release();
    this.#geometryDirty.clear();
    this.#paintDirty.clear();
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

  private writeGeometry(
    id: string,
    deadline: number,
    now: () => number,
    publication: ScenePublicationBudget,
  ): boolean {
    const entry = this.#mounted.get(id);
    const record = this.#store.get(id);
    if (
      entry === undefined ||
      record === undefined ||
      entry.geometryVersion === record.geometryVersion
    ) {
      this.#committedGeometry.finish(id);
      this.#deferredPreviews.delete(id);
      return true;
    }
    const pressure = this.#store.pressureGeometry?.(record.id, record.geometryVersion);
    const pending =
      this.#committedGeometry.has(id) ||
      (record.element.kind === "stroke" && record.element.style.pressureEnabled);
    const parts =
      (sameStrokeShape(entry.displayedElement, record.element)
        ? entry.displayedPathParts
        : undefined) ??
      this.#pathCache.read(record.element, pressure, record.geometryVersion) ??
      (pending
        ? this.#committedGeometry.prepare(record, deadline, now, pressure)
        : this.#pathCache.build(record.element, pressure));
    if (parts === undefined) return false;
    this.updateGeometry(entry, record, parts, publication);
    const desired = this.#committedGeometry.finish(id);
    if (this.#deferredPreviews.delete(id)) this.#committedPreviewIds.push(id);
    if (desired !== undefined)
      this.applyPreviewTransform(id, desired.transform, desired.version, desired.strokeWidthScale);
    return true;
  }
  private updateGeometry(
    entry: MountedSceneElement,
    record: SceneElementRecord,
    parts: readonly SvgPathPart[],
    publication?: ScenePublicationBudget,
  ): void {
    if (!this.#pathCache.has(record.id, record.geometryVersion))
      this.#pathCache.completePreparation(record.element, parts, record.geometryVersion);
    updateMountedGeometry(
      entry,
      record,
      parts,
      this.#dom.ownerDocument,
      this.#dom.group(entry.band),
      this.#instrumentation,
    );
    if (this.#selectionTraces.update(entry, record.element, parts, publication))
      this.#selectionDirty.delete(entry.id);
    else this.#selectionDirty.add(entry.id);
  }
  private writePaint(id: string, publication: ScenePublicationBudget): void {
    const entry = this.#mounted.get(id);
    const record = this.#store.get(id);
    if (entry === undefined || record === undefined || entry.paintVersion === record.paintVersion)
      return;
    updateMountedPaint(entry, record, entry.pathParts, this.#instrumentation);
    entry.displayedElement = record.element;
    if (!this.#selectionTraces.update(entry, record.element, entry.displayedPathParts, publication))
      this.#selectionDirty.add(id);
  }
  private commitVisibility(visibility: VisibilityResult, orderProofEpoch?: number): void {
    commitVisibleBands(
      this.#committedIds,
      this.#committedCounts,
      visibility,
      orderProofEpoch === undefined
        ? undefined
        : {
            mounted: this.#mounted,
            store: this.#store,
            epoch: orderProofEpoch,
          },
    );
  }
}
