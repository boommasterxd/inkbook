import { PreparedPressurePathCache } from "./prepared-pressure-path-cache";
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
    const current = () => {
      const value = access.records?.(id);
      return (
        value?.geometryVersion === geometryVersion &&
        value.element.kind === "stroke" &&
        value.element.style.pressureEnabled
      );
    };
    return {
      readPath: () => (current() ? paths.read(id, geometryVersion) : undefined),
      publishPath: (parts) => {
        if (!current()) return;
        const previous = paths.statistics().bytes;
        paths.publish(id, geometryVersion, parts);
        if (previous !== paths.statistics().bytes) access.notify?.();
      },
      readWindow: (index) => (current() ? cache.read(id, geometryVersion, index) : undefined),
      publishWindow: (index, window) => {
        if (!current()) return;
        const previous = cache.statistics().bytes;
        cache.publish(id, geometryVersion, index, window);
        if (previous !== cache.statistics().bytes) access.notify?.();
      },
    };
  }

  public releasePressureGeometry(): void {
    if (this.#pressureReleased) return;
    this.#pressureReleased = true;
    this.#pressureAccess.records = undefined;
    this.#pressureAccess.notify = undefined;
    this.#pressureCache.release();
    this.#pressurePaths.release();
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
  }

  public resetStatistics(): void {
    this.#anchorCache.resetStatistics();
    this.#pressureCache.resetStatistics();
    this.#pressurePaths.resetStatistics();
  }

  public publish(delta: StoreDelta, instrumentation: MutableStoreInstrumentation): StoreDelta {
    const previousPressureBytes =
      this.#pressureCache.statistics().bytes + this.#pressurePaths.statistics().bytes;
    this.#estimatedRetainedBytes = applyStoreDeltaBytes(this.#estimatedRetainedBytes, delta);
    for (const change of delta.changes) {
      if (change.after === null || change.domains.includes("geometry")) {
        this.#anchorCache.invalidate(change.id);
        this.#pressureCache.invalidate(change.id);
        this.#pressurePaths.invalidate(change.id);
      }
    }
    instrumentation.publishedDeltas += 1;
    instrumentation.deltaEntries += delta.changes.length;
    if (
      previousPressureBytes !==
      this.#pressureCache.statistics().bytes + this.#pressurePaths.statistics().bytes
    )
      this.notifyMemory();
    for (const listener of this.#listeners) listener(delta);
    return delta;
  }
}
