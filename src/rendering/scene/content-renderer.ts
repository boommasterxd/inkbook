import type { RenderBand } from "../../domain/commands/render-bands";
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
import { MountSlice, mountCost } from "./mount-slice";
import { SceneElementFades, type FadeSlice } from "./scene-element-fades";
import { SceneSelectionTraces } from "./selection-traces";
import type { SceneDom } from "./scene-dom";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";
import type { SceneVisibilityState, VisibilityResult } from "./visibility-state";
import { SceneVisibilityReconciler, type PreviewTransform } from "./scene-visibility-reconciler";

const EMPTY_IDS: readonly string[] = Object.freeze([]);

export class SceneContentRenderer {
  readonly #dom: SceneDom;
  readonly #committedIds: Record<RenderBand, (string | undefined)[]> = {
    content: [],
    highlight: [],
  };
  readonly #committedCounts: Record<RenderBand, number> = { content: 0, highlight: 0 };
  readonly #geometryDirty = new Set<string>();
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #mounted = new Map<string, MountedSceneElement>();
  readonly #fades = new SceneElementFades(this.#mounted);
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

  public constructor(
    dom: SceneDom,
    store: SceneStorePort,
    visibility: SceneVisibilityState,
    pathCache: ScenePathCache,
    instrumentation: MutableSceneInstrumentation,
  ) {
    this.#dom = dom;
    this.#selectionTraces = new SceneSelectionTraces(dom.selectionTraceGroup, instrumentation);
    this.#store = store;
    this.#pathCache = pathCache;
    this.#instrumentation = instrumentation;
    this.#reconciler = new SceneVisibilityReconciler({
      dom,
      instrumentation,
      isExitReady: (id, now) => this.isElementFadeExitReady(id, now),
      mounted: this.#mounted,
      orderDirty: this.#orderDirty,
      pathCache,
      store,
      visibility,
    });
  }

  public setSelectedElements(ids: ReadonlySet<string>): void {
    if (this.#selectionTraces.setSelection(ids)) this.markSelectionDirty();
  }

  public setSelectionHighlightsEnabled(enabled: boolean): void {
    if (this.#selectionTraces.setHighlightsEnabled(enabled)) this.markSelectionDirty();
  }

  private markSelectionDirty(): void {
    for (const id of this.#mounted.keys()) {
      if (this.#selectionTraces.needsUpdate(id, this.#mounted.get(id)?.displayedElement))
        this.#selectionDirty.add(id);
    }
  }

  public setSelectionContext(context: Parameters<SceneSelectionTraces["setContext"]>[0]): void {
    this.#selectionTraces.setContext(context);
  }

  public flushSelectionContext(): void {
    this.#selectionTraces.flushContext();
  }

  public selectionTraceBytes(): number {
    return this.#selectionTraces.memoryUsage();
  }

  public get mountedCount(): number {
    return this.#mounted.size;
  }

  public hasMounted(id: string): boolean {
    return this.#mounted.has(id);
  }

  public mountedIds(band: RenderBand): readonly string[] {
    const idsInBand = this.#committedIds[band];
    const ids: string[] = [];
    for (let index = 0; index < this.#committedCounts[band]; index += 1) {
      const id = idsInBand[index];
      if (id !== undefined && this.#mounted.has(id)) ids.push(id);
    }
    return ids;
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
    this.markOrderDirty(id);
    this.#reconciler.cancel();
  }

  public markOrders(ids: readonly string[]): void {
    for (const id of ids) this.markOrderDirty(id);
    this.#reconciler.cancel();
  }

  private markOrderDirty(id: string): void {
    const record = this.#store.get(id);
    if (record === undefined) {
      this.#orderDirty.content.add(id);
      this.#orderDirty.highlight.add(id);
    } else this.#orderDirty[record.band].add(id);
  }

  public materializePreviewGeometry(previews: ReadonlyMap<string, PreviewTransform>): void {
    for (const [id, preview] of previews) {
      if (preview.transform === null) continue;
      this.writeGeometry(id);
      this.#geometryDirty.delete(id);
    }
  }

  public writeMountedChanges(deadline: number, now: () => number): boolean {
    if (this.writeDirtySet(this.#geometryDirty, deadline, now, (id) => this.writeGeometry(id))) {
      return true;
    }
    if (this.writeDirtySet(this.#paintDirty, deadline, now, (id) => this.writePaint(id)))
      return true;
    return this.writeSelectionTraces(deadline, now);
  }

  public get hasPendingExitCleanup(): boolean {
    return this.#reconciler.hasPendingCleanup;
  }

  public get needsVisibilityRestart(): boolean {
    return this.#reconciler.needsRestart;
  }

  public replaceVisibility(visibility: VisibilityResult): void {
    this.#reconciler.replace(visibility);
  }

  public cancelPendingVisibility(): void {
    this.#reconciler.cancel();
  }

  public reconcileVisibility(
    deadline: number,
    now: () => number,
    previewTransforms: ReadonlyMap<string, PreviewTransform>,
    previewElements: ReadonlyMap<string, InkElementV1>,
  ): boolean {
    const wasCleaning = this.#reconciler.hasPendingCleanup;
    const result = this.#reconciler.reconcile(deadline, now, previewTransforms, previewElements);
    if (wasCleaning && !this.#reconciler.hasPendingCleanup) {
      this.#selectionTraces.prune(this.#mounted);
    }
    if (result.committedVisibility !== undefined) {
      this.commitVisibility(result.committedVisibility);
      this.#newlyMountedIds = result.newlyMountedIds;
      this.#selectionTraces.prune(this.#mounted);
      for (const id of result.newlyMountedIds) {
        if (this.#selectionTraces.needsUpdate(id, this.#mounted.get(id)?.displayedElement))
          this.#selectionDirty.add(id);
      }
    }
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
      updatePreviewTransform(entry, transform, version, strokeWidthScale, this.#instrumentation);
      this.#selectionTraces.transform(id, entry);
    }
  }

  public applyElementPreview(element: InkElementV1): boolean {
    return this.applyCanonicalElementPreview(element, buildElementPathParts(element));
  }

  public applyCanonicalElementPreview(
    element: InkElementV1,
    parts: readonly SvgPathPart[],
  ): boolean {
    const entry = this.#mounted.get(element.id);
    const record = this.#store.get(element.id);
    if (entry === undefined || record === undefined) return false;
    updateMountedElementPreview(entry, record, element, parts, {
      instrumentation: this.#instrumentation,
      ownerDocument: this.#dom.ownerDocument,
      parent: this.#dom.group(entry.band),
    });
    this.#selectionTraces.update(entry, element, parts);
    this.#selectionDirty.delete(element.id);
    return true;
  }

  public clearElementPreview(id: string): void {
    const entry = this.#mounted.get(id);
    const record = this.#store.get(id);
    if (entry === undefined || record === undefined) return;
    const parts =
      entry.geometryVersion === record.geometryVersion
        ? entry.pathParts
        : this.#pathCache.build(record.element);
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
    if (this.#mounted.get(id)?.fadeActive !== true) this.#fades.set([id], 0);
  }

  public get pendingElementFades(): boolean {
    return this.#fades.pending;
  }

  public flushElementFades(deadline: number, now: () => number): boolean {
    return this.#fades.flush(deadline, now);
  }

  public isElementFadeExitReady(id: string, now: number): boolean {
    return this.#fades.isExitReady(id, now);
  }

  public setElementMotion(ids: readonly string[], opacity: number | null, scale = 1): void {
    for (const id of ids) {
      const entry = this.#mounted.get(id);
      if (entry !== undefined) setMountedElementMotion(entry, opacity, scale);
    }
  }

  public release(): void {
    this.#fades.release();
    this.#selectionTraces.release();
    this.#selectionDirty.clear();
    this.#reconciler.release();
    this.#geometryDirty.clear();
    this.#paintDirty.clear();
    this.#orderDirty.content.clear();
    this.#orderDirty.highlight.clear();
    this.#mounted.clear();
    this.#newlyMountedIds = EMPTY_IDS;
    this.#committedIds.content.length = 0;
    this.#committedIds.highlight.length = 0;
    this.#committedCounts.content = 0;
    this.#committedCounts.highlight = 0;
  }

  private writeGeometry(id: string): void {
    const entry = this.#mounted.get(id);
    const record = this.#store.get(id);
    if (
      entry === undefined ||
      record === undefined ||
      entry.geometryVersion === record.geometryVersion
    )
      return;
    const parts = this.#pathCache.build(record.element);
    this.updateGeometry(entry, record, parts);
  }

  private updateGeometry(
    entry: MountedSceneElement,
    record: SceneElementRecord,
    parts: readonly SvgPathPart[],
  ): void {
    updateMountedGeometry(
      entry,
      record,
      parts,
      this.#dom.ownerDocument,
      this.#dom.group(entry.band),
      this.#instrumentation,
    );
    this.#selectionTraces.update(entry, record.element, parts);
    this.#selectionDirty.delete(entry.id);
  }

  private writeSelectionTraces(deadline: number, now: () => number): boolean {
    const slice = new MountSlice(deadline, now);
    for (const id of this.#selectionDirty) {
      const entry = this.#mounted.get(id);
      const record = this.#store.get(id);
      if (entry !== undefined && record !== undefined) {
        const cost = this.#selectionTraces.includes(entry.displayedElement)
          ? mountCost({ ...record, element: entry.displayedElement })
          : { geometry: 0, strokePoints: 0 };
        if (slice.blockingReason(cost) !== undefined) return true;
        this.#selectionTraces.update(entry, entry.displayedElement, entry.displayedPathParts);
        slice.record(cost);
      }
      this.#selectionDirty.delete(id);
    }
    return false;
  }

  private writePaint(id: string): void {
    const entry = this.#mounted.get(id);
    const record = this.#store.get(id);
    if (entry === undefined || record === undefined || entry.paintVersion === record.paintVersion)
      return;
    updateMountedPaint(entry, record, entry.pathParts, this.#instrumentation);
    entry.displayedElement = record.element;
    this.#selectionTraces.update(entry, record.element, entry.displayedPathParts);
  }

  private commitVisibility(visibility: VisibilityResult): void {
    this.commitBandVisibility("highlight", visibility.highlight);
    this.commitBandVisibility("content", visibility.content);
  }

  private commitBandVisibility(band: RenderBand, visibility: VisibilityResult[RenderBand]): void {
    const ids = this.#committedIds[band];
    for (let index = 0; index < visibility.count; index += 1) ids[index] = visibility.ids[index];
    for (let index = visibility.count; index < this.#committedCounts[band]; index += 1) {
      ids[index] = undefined;
    }
    this.#committedCounts[band] = visibility.count;
  }

  private writeDirtySet(
    dirty: Set<string>,
    deadline: number,
    now: () => number,
    write: (id: string) => void,
  ): boolean {
    let processed = 0;
    for (const id of dirty) {
      if (processed > 0 && now() >= deadline) return true;
      write(id);
      dirty.delete(id);
      processed += 1;
    }
    return false;
  }
}
