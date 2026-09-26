import type { SvgPathPart } from "../../domain/geometry/svg-path-part";
import {
  createMountedElement,
  updatePreviewTransform,
  type MountedSceneElement,
} from "./mounted-element";
import type { MountSlice } from "./mount-slice";
import type { ScenePathCache } from "./path-cache";
import type { ProgressivePreviewPath } from "./progressive-preview-path";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";

export interface PreviewTransform {
  readonly strokeWidthScale: number | null;
  readonly transform: string | null;
  readonly version: number;
}

interface PendingPath {
  readonly id: string;
  readonly version: number;
  readonly path: ProgressivePreviewPath;
}

interface MountPreparationOptions {
  readonly ownerDocument: Document;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly pathCache: ScenePathCache;
  readonly store: SceneStorePort;
}

/** Owns one cancellable cold pressure build, never a queue of retained documents. */
export class SceneMountPreparation {
  #pending: PendingPath | undefined;

  public constructor(private readonly options: MountPreparationOptions) {}

  public isCurrent(entry: MountedSceneElement): boolean {
    const record = this.options.store.get(entry.id);
    return (
      record?.geometryVersion === entry.geometryVersion &&
      record.paintVersion === entry.paintVersion &&
      record.band === entry.band
    );
  }

  public get pendingId(): string | undefined {
    return this.#pending?.id;
  }

  public memoryUsage(): number {
    return this.#pending?.path.memoryUsage() ?? 0;
  }

  public cancel(retainVisible?: (id: string) => boolean): void {
    const pending = this.#pending;
    if (
      pending !== undefined &&
      retainVisible?.(pending.id) === true &&
      this.options.store.get(pending.id)?.geometryVersion === pending.version
    )
      return;
    this.#pending?.path.cancel();
    this.#pending = undefined;
  }

  public stage(
    record: SceneElementRecord,
    slice: MountSlice,
    preview: PreviewTransform | undefined,
  ): MountedSceneElement | undefined {
    const parts = this.prepare(record, slice);
    if (parts === undefined) return undefined;
    const entry = createMountedElement(
      this.options.ownerDocument,
      record,
      parts,
      this.options.instrumentation,
    );
    if (preview !== undefined)
      updatePreviewTransform(
        entry,
        preview.transform,
        preview.version,
        preview.strokeWidthScale,
        this.options.instrumentation,
      );
    return entry;
  }

  private prepare(
    record: SceneElementRecord,
    slice: MountSlice,
  ): readonly SvgPathPart[] | undefined {
    const { pathCache, store } = this.options;
    const pressure = store.pressureGeometry?.(record.id, record.geometryVersion);
    const cached =
      pathCache.take(record.id, record.geometryVersion) ?? pathCache.read(record.element, pressure);
    if (cached !== undefined) {
      this.cancel();
      return cached;
    }
    if (record.element.kind !== "stroke" || !record.element.style.pressureEnabled)
      return pathCache.build(record.element, pressure);
    if (this.#pending?.id !== record.id || this.#pending.version !== record.geometryVersion) {
      this.cancel();
      this.#pending = {
        id: record.id,
        version: record.geometryVersion,
        path: pathCache.startPreparation(record.element, pressure),
      };
    }
    if (!slice.prepare(this.#pending.path)) return undefined;
    const parts = this.#pending.path.parts!;
    pathCache.completePreparation(record.element, parts);
    this.#pending = undefined;
    return parts;
  }
}
