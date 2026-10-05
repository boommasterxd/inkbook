import type { SvgPathPart } from "../../domain/geometry/svg-path-part";
import {
  createMountedElement,
  updatePreviewTransform,
  type MountedSceneElement,
} from "./mounted-element";
import type { MountSlice } from "./mount-slice";
import type { ScenePathCache } from "./path-cache";
import type { ProgressivePreviewPath } from "./progressive-preview-path";
import { localPressureGeometry } from "./stroke-position";
import { RemoteScenePaths } from "./remote-scene-paths";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";
import type { DetachedSceneElementCache } from "./detached-element-cache";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

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
  readonly upcomingIds?: () => Iterable<string>;
  readonly onPathsReady?: () => void;
  readonly detachedCache?: DetachedSceneElementCache;
  readonly scheduler?: WorkScheduler;
  readonly isViewport?: (record: SceneElementRecord) => boolean;
}

/** Owns one cancellable cold stroke build, never a queue of retained documents. */
export class SceneMountPreparation {
  #pending: PendingPath | undefined;
  readonly #remote: RemoteScenePaths;

  public constructor(private readonly options: MountPreparationOptions) {
    this.#remote = new RemoteScenePaths(options.store, {
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.isViewport === undefined ? {} : { isViewport: options.isViewport }),
      ...(options.onPathsReady === undefined ? {} : { onReady: options.onPathsReady }),
      isCached: (record) =>
        options.pathCache.has(record.id, record.geometryVersion) ||
        options.pathCache.read(
          record.element,
          options.store.pressureGeometry?.(record.id, record.geometryVersion),
        ) !== undefined,
      onPrepared: (record, parts) => {
        const pressure = options.store.pressureGeometry?.(record.id, record.geometryVersion);
        localPressureGeometry(record.element, pressure)?.publishPath?.(parts);
        options.pathCache.completePreparation(record.element, parts);
      },
    });
  }

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

  public get readyContours(): number {
    return this.#remote.readyCount;
  }

  public get waiting(): boolean {
    return this.#pending === undefined && this.#remote.waiting;
  }

  public get waitingForPreparation(): boolean {
    return this.#pending !== undefined || this.#remote.waiting;
  }

  public memoryUsage(): number {
    return (this.#pending?.path.memoryUsage() ?? 0) + this.#remote.memoryUsage();
  }

  public cancel(retainVisible?: (id: string) => boolean): void {
    this.#remote.cancel(retainVisible);
    const pending = this.#pending;
    if (
      pending !== undefined &&
      retainVisible?.(pending.id) === true &&
      this.options.store.get(pending.id)?.geometryVersion === pending.version
    )
      return;
    this.cancelLocal();
  }

  private cancelLocal(): void {
    this.#pending?.path.cancel();
    this.#pending = undefined;
  }

  public stage(
    record: SceneElementRecord,
    slice: MountSlice,
    preview: PreviewTransform | undefined,
    allowLocal = true,
  ): MountedSceneElement | undefined {
    if (
      this.options.detachedCache?.isPendingRemoval(record.id) ||
      this.options.detachedCache?.isReserved(record.id)
    )
      return undefined;
    let entry = this.options.detachedCache?.take(record, this.options.instrumentation);
    if (entry === undefined) {
      if (this.options.detachedCache?.isPendingRemoval(record.id)) return undefined;
      const parts = this.prepare(record, slice, allowLocal);
      if (parts === undefined) return undefined;
      entry = createMountedElement(
        this.options.ownerDocument,
        record,
        parts,
        this.options.instrumentation,
      );
    }
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
    allowLocal: boolean,
  ): readonly SvgPathPart[] | undefined {
    const { pathCache, store } = this.options;
    const pressure = store.pressureGeometry?.(record.id, record.geometryVersion);
    const cached =
      pathCache.take(record.id, record.geometryVersion) ?? pathCache.read(record.element, pressure);
    if (cached !== undefined) {
      this.#remote.release(record.id, this.options.upcomingIds);
      if (this.#pending?.id === record.id) this.cancelLocal();
      return cached;
    }
    if (record.element.kind !== "stroke") return pathCache.build(record.element, pressure);
    if (this.#pending?.id !== record.id || this.#pending.version !== record.geometryVersion) {
      if (this.#pending !== undefined) return undefined;
      const remote = this.#remote.read(record, this.options.upcomingIds ?? (() => []));
      if (remote === "pending") return undefined;
      if (remote !== undefined) {
        localPressureGeometry(record.element, pressure)?.publishPath?.(remote);
        pathCache.completePreparation(record.element, remote);
        return remote;
      }
      this.#pending = {
        id: record.id,
        version: record.geometryVersion,
        path: pathCache.startPreparation(record.element, pressure),
      };
    }
    if (!allowLocal || !slice.prepare(this.#pending.path)) return undefined;
    const parts = this.#pending.path.parts!;
    localPressureGeometry(record.element, pressure)?.publishPath?.(parts);
    pathCache.completePreparation(record.element, parts);
    this.#pending = undefined;
    return parts;
  }
}
