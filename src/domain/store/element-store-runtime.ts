import { PreparedPressurePathCache } from "./prepared-pressure-path-cache";
import { PreparedStrokeCenterCache, sameLocalSelectionShape } from "./prepared-stroke-center-cache";
import type { StrokeElementV1 } from "../schema/public";
import type { PreparedPressureGeometryPort } from "../geometry/prepared-pressure-geometry";
import { PreparedPressureWindowCache } from "./prepared-pressure-window-cache";
import { isAnchorTarget, type ResolvedShapeAnchor } from "../geometry/anchors";

import { SemanticAnchorCache } from "./semantic-anchor-cache";
import { applyStoreDeltaBytes, estimateInitialStoreBytes } from "./active-document-memory-estimate";
import type {
  ElementRecord,
  ElementStoreMemoryUsage,
  ElementStoreInstrumentation,
  StoreDelta,
  StoreDeltaListener,
} from "./types";
import type { MutableStoreInstrumentation } from "./instrumentation";

interface PressureCacheAccess {
  records: ((id: string) => ElementRecord | undefined) | undefined;
  notify: (() => void) | undefined;
}

export class ElementStoreRuntime {
  readonly #pressureCache = new PreparedPressureWindowCache();
  readonly #pressurePaths = new PreparedPressurePathCache();
  readonly #strokeCenters = new PreparedStrokeCenterCache();
  #pressureReleased = false;
  readonly #pressureAccess: PressureCacheAccess = { records: undefined, notify: undefined };
  readonly #anchorCache = new SemanticAnchorCache();
  #estimatedRetainedBytes = 0;
  readonly #listeners = new Set<StoreDeltaListener>();
  readonly #memoryListeners = new Set<() => void>();

  public instrumentation(base: MutableStoreInstrumentation): ElementStoreInstrumentation {
    const anchors = this.#anchorCache.statistics();
    const pressure = this.#pressureCache.statistics();
    return Object.freeze({
      ...base,
      pressureWindowCacheBytes: pressure.bytes,
      pressureWindowCacheEntries: pressure.entries,
      pressureWindowCacheHits: pressure.hits,
      pressureWindowCacheEvictions: pressure.evictions,
      anchorBuilds: anchors.builds,
      anchorCacheBytes: anchors.bytes,
      anchorCacheEntries: anchors.entries,
      anchorCacheEvictions: anchors.evictions,
      anchorCacheHits: anchors.hits,
      estimatedRetainedBytes: this.#estimatedRetainedBytes,
    });
  }

  public semanticAnchors(record: ElementRecord | undefined): readonly ResolvedShapeAnchor[] | null {
    if (record === undefined || !isAnchorTarget(record.element)) return null;
    const result = this.#anchorCache.resolve(
      record.element.id,
      record.geometryVersion,
      record.element,
    );
    if (!result.hit && this.#anchorCache.retentionEnabled) {
      for (const listener of this.#memoryListeners) listener();
    }
    return result.anchors;
  }

  public pressureGeometry(
    id: string,
    geometryVersion: number,
    record: (id: string) => ElementRecord | undefined,
  ): PreparedPressureGeometryPort {
    const access = this.#pressureAccess;
    const cache = this.#pressureCache;
    const paths = this.#pressurePaths;
    if (!this.#pressureReleased) {
      access.records = record;
      access.notify = () => this.notifyMemory();
    }
    const stroke = (): StrokeElementV1 | undefined => {
      const value = access.records?.(id);
      return value?.geometryVersion === geometryVersion && value.element.kind === "stroke"
        ? (value.element as StrokeElementV1)
        : undefined;
    };
    const current = () => stroke()?.style.pressureEnabled === true;
    const local = this.#localGeometry(id, geometryVersion, stroke);
    const isLocal = () => {
      const offset = stroke()?.offset;
      return offset === undefined || (offset.x === 0 && offset.y === 0);
    };
    return {
      local: () => local,
      readCenters: (index) => local.readCenters?.(index),
      publishCenters: (index, centers) => local.publishCenters?.(index, centers),
      readPath: () => (current() ? paths.read(id, geometryVersion) : undefined),
      publishPath: (parts) => {
        if (!current()) return;
        const previous = paths.statistics().bytes;
        paths.publish(id, geometryVersion, parts);
        if (previous !== paths.statistics().bytes) access.notify?.();
      },
      readWindow: (index) =>
        current()
          ? isLocal()
            ? local.readWindow(index)
            : cache.read(id, geometryVersion, index)
          : undefined,
      readWindowMeasurement: (index) =>
        current()
          ? isLocal()
            ? local.readWindowMeasurement?.(index)
            : cache.readMeasurement(id, geometryVersion, index)
          : undefined,
      publishWindow: (index, window) => {
        if (!current()) return;
        if (isLocal()) return local.publishWindow(index, window);
        const previous = cache.statistics().bytes;
        const numericBytes = cache.publish(id, geometryVersion, index, window);
        if (previous !== cache.statistics().bytes) access.notify?.();
        return numericBytes;
      },
    };
  }

  #localGeometry(
    id: string,
    version: number,
    current: () => StrokeElementV1 | undefined,
  ): PreparedPressureGeometryPort {
    const centers = this.#strokeCenters;
    const windows = this.#pressureCache;
    const key = `local:${id}`;
    const prepare = <T>(work: (stroke: StrokeElementV1) => T): T | undefined => {
      const stroke = current();
      if (stroke === undefined) return;
      const before = centers.statistics().bytes + windows.statistics().bytes;
      const result = work(stroke);
      if (before !== centers.statistics().bytes + windows.statistics().bytes)
        this.#pressureAccess.notify?.();
      return result;
    };
    return {
      readCenters: (index) => prepare((stroke) => centers.read(id, version, stroke, index)),
      publishCenters: (index, values) =>
        prepare((stroke) => centers.publish(id, version, stroke, index, values)),
      readWindow: (index) =>
        prepare((stroke) =>
          stroke.style.pressureEnabled
            ? windows.read(key, centers.resolve(id, version, stroke).shapeVersion, index)
            : undefined,
        ),
      readWindowMeasurement: (index) =>
        prepare((stroke) =>
          stroke.style.pressureEnabled
            ? windows.readMeasurement(key, centers.resolve(id, version, stroke).shapeVersion, index)
            : undefined,
        ),
      publishWindow: (index, window) =>
        prepare((stroke) =>
          stroke.style.pressureEnabled
            ? windows.publish(key, centers.resolve(id, version, stroke).shapeVersion, index, window)
            : undefined,
        ),
    };
  }

  public *preparedPressurePaths(
    record: (id: string) => ElementRecord | undefined,
    ids?: ReadonlySet<string>,
  ) {
    const versions =
      ids === undefined
        ? this.#pressurePaths.cachedVersions()
        : this.#pressurePaths.versionsFor(ids);
    for (const [id, version] of versions) {
      const current = record(id);
      if (
        current?.geometryVersion !== version ||
        current.element.kind !== "stroke" ||
        !current.element.style.pressureEnabled
      )
        continue;
      const parts = this.#pressurePaths.read(id, version);
      if (parts !== undefined) yield { record: current, parts };
    }
  }

  public releasePressureGeometry(): void {
    if (this.#pressureReleased) return;
    this.#pressureReleased = true;
    this.#pressureAccess.records = undefined;
    this.#pressureAccess.notify = undefined;
    this.#pressureCache.release();
    this.#pressurePaths.release();
    this.#strokeCenters.release();
    this.notifyMemory();
  }

  private notifyMemory(): void {
    for (const listener of this.#memoryListeners) listener();
  }

  public subscribe(listener: StoreDeltaListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public initializeMemory(records: Iterable<ElementRecord>): void {
    this.#estimatedRetainedBytes = estimateInitialStoreBytes(records);
  }

  public memoryUsage(): ElementStoreMemoryUsage {
    return {
      anchorCacheBytes: this.#anchorCache.statistics().bytes,
      modelBytes: this.#estimatedRetainedBytes,
      pressureWindowCacheBytes: this.#pressureCache.statistics().bytes,
      pressurePathCacheBytes: this.#pressurePaths.statistics().bytes,
      selectionGeometryCacheBytes: this.#strokeCenters.statistics().bytes,
    };
  }

  public subscribeMemoryUsage(listener: () => void): () => void {
    this.#memoryListeners.add(listener);
    return () => this.#memoryListeners.delete(listener);
  }

  public setActiveDocumentMemoryPressure(active: boolean): void {
    this.#anchorCache.setRetentionEnabled(!active);
    this.#pressureCache.setRetentionEnabled(!active);
    this.#pressurePaths.setRetentionEnabled(!active);
    this.#strokeCenters.setRetentionEnabled(!active);
  }

  public resetStatistics(): void {
    this.#anchorCache.resetStatistics();
    this.#pressureCache.resetStatistics();
    this.#pressurePaths.resetStatistics();
    this.#strokeCenters.resetStatistics();
  }

  public publish(delta: StoreDelta, instrumentation: MutableStoreInstrumentation): StoreDelta {
    const previousPressureBytes =
      this.#pressureCache.statistics().bytes +
      this.#pressurePaths.statistics().bytes +
      this.#strokeCenters.statistics().bytes;
    this.#estimatedRetainedBytes = applyStoreDeltaBytes(this.#estimatedRetainedBytes, delta);
    for (const change of delta.changes) {
      if (change.after === null || change.domains.includes("geometry")) {
        this.#anchorCache.invalidate(change.id);
        this.#pressureCache.invalidate(change.id);
        this.#pressurePaths.invalidate(change.id);
        const before = change.before?.element;
        const after = change.after?.element;
        if (
          before?.kind !== "stroke" ||
          after?.kind !== "stroke" ||
          !sameLocalSelectionShape(before as StrokeElementV1, after as StrokeElementV1)
        ) {
          this.#strokeCenters.invalidate(change.id);
          this.#pressureCache.invalidate(`local:${change.id}`);
        }
      }
    }
    instrumentation.publishedDeltas += 1;
    instrumentation.deltaEntries += delta.changes.length;
    if (
      previousPressureBytes !==
      this.#pressureCache.statistics().bytes +
        this.#pressurePaths.statistics().bytes +
        this.#strokeCenters.statistics().bytes
    )
      this.notifyMemory();
    for (const listener of this.#listeners) listener(delta);
    return delta;
  }
}
