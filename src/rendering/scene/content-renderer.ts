import type { RenderBand } from "../../domain/commands/render-bands";
import { buildElementPathParts } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import {
  updateMountedGeometry,
  updateMountedElementPreview,
  updateMountedPaint,
  updatePreviewTransform,
  setMountedElementFade,
  setMountedElementMotion,
  type MountedSceneElement,
} from "./mounted-element";
import type { ScenePathCache } from "./path-cache";
import type { SceneDom } from "./scene-dom";
import type { MutableSceneInstrumentation, SceneStorePort } from "./types";
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
  #newlyMountedIds: readonly string[] = EMPTY_IDS;
  readonly #orderDirty: Record<RenderBand, Set<string>> = {
    content: new Set(),
    highlight: new Set(),
  };
  readonly #paintDirty = new Set<string>();
  readonly #pathCache: ScenePathCache;
  readonly #reconciler: SceneVisibilityReconciler;
  readonly #store: SceneStorePort;

  public constructor(
    dom: SceneDom,
    store: SceneStorePort,
    visibility: SceneVisibilityState,
    pathCache: ScenePathCache,
    instrumentation: MutableSceneInstrumentation,
  ) {
    this.#dom = dom;
    this.#store = store;
    this.#pathCache = pathCache;
    this.#instrumentation = instrumentation;
    this.#reconciler = new SceneVisibilityReconciler({
      dom,
      instrumentation,
      mounted: this.#mounted,
      orderDirty: this.#orderDirty,
      pathCache,
      store,
      visibility,
    });
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
    this.#geometryDirty.add(id);
    this.#pathCache.invalidate(id);
  }

  public markPaint(id: string): void {
    this.#paintDirty.add(id);
  }

  public markOrder(id: string): void {
    const record = this.#store.get(id);
    if (record === undefined) {
      this.#orderDirty.content.add(id);
      this.#orderDirty.highlight.add(id);
    } else this.#orderDirty[record.band].add(id);
    this.#reconciler.cancel();
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
    return this.writeDirtySet(this.#paintDirty, deadline, now, (id) => this.writePaint(id));
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
  ): boolean {
    const result = this.#reconciler.reconcile(deadline, now, previewTransforms);
    if (result.committedVisibility !== undefined) {
      this.commitVisibility(result.committedVisibility);
      this.#newlyMountedIds = result.newlyMountedIds;
    }
    return result.pending;
  }

  public promoteVisible(id: string): boolean {
    return this.#reconciler.promote(id);
  }

  public applyPreviewTransform(id: string, transform: string | null, version: number): void {
    const entry = this.#mounted.get(id);
    if (entry !== undefined) {
      updatePreviewTransform(entry, transform, version, this.#instrumentation);
    }
  }

  public applyElementPreview(element: InkElementV1): boolean {
    const entry = this.#mounted.get(element.id);
    const record = this.#store.get(element.id);
    if (entry === undefined || record === undefined) return false;
    updateMountedElementPreview(entry, record, element, buildElementPathParts(element), {
      instrumentation: this.#instrumentation,
      ownerDocument: this.#dom.ownerDocument,
      parent: this.#dom.group(entry.band),
    });
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
    updateMountedGeometry(
      entry,
      record,
      parts,
      this.#dom.ownerDocument,
      this.#dom.group(entry.band),
      this.#instrumentation,
    );
  }

  public setElementFade(ids: readonly string[], durationMs: number | null): void {
    for (const id of ids) {
      const entry = this.#mounted.get(id);
      if (entry !== undefined) setMountedElementFade(entry, durationMs);
    }
  }

  public setElementMotion(ids: readonly string[], opacity: number | null, scale = 1): void {
    for (const id of ids) {
      const entry = this.#mounted.get(id);
      if (entry !== undefined) setMountedElementMotion(entry, opacity, scale);
    }
  }

  public release(): void {
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
    updateMountedGeometry(
      entry,
      record,
      parts,
      this.#dom.ownerDocument,
      this.#dom.group(entry.band),
      this.#instrumentation,
    );
  }

  private writePaint(id: string): void {
    const entry = this.#mounted.get(id);
    const record = this.#store.get(id);
    if (entry === undefined || record === undefined || entry.paintVersion === record.paintVersion)
      return;
    updateMountedPaint(entry, record, entry.pathParts, this.#instrumentation);
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
