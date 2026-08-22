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

export class ElementStoreRuntime {
  readonly #anchorCache = new SemanticAnchorCache();
  #estimatedRetainedBytes = 0;
  readonly #listeners = new Set<StoreDeltaListener>();
  readonly #memoryListeners = new Set<() => void>();

  public instrumentation(base: MutableStoreInstrumentation): ElementStoreInstrumentation {
    const anchors = this.#anchorCache.statistics();
    return Object.freeze({
      ...base,
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
    };
  }

  public subscribeMemoryUsage(listener: () => void): () => void {
    this.#memoryListeners.add(listener);
    return () => this.#memoryListeners.delete(listener);
  }

  public setActiveDocumentMemoryPressure(active: boolean): void {
    this.#anchorCache.setRetentionEnabled(!active);
  }

  public resetStatistics(): void {
    this.#anchorCache.resetStatistics();
  }

  public publish(delta: StoreDelta, instrumentation: MutableStoreInstrumentation): StoreDelta {
    this.#estimatedRetainedBytes = applyStoreDeltaBytes(this.#estimatedRetainedBytes, delta);
    for (const change of delta.changes) {
      if (change.after === null || change.domains.includes("geometry")) {
        this.#anchorCache.invalidate(change.id);
      }
    }
    instrumentation.publishedDeltas += 1;
    instrumentation.deltaEntries += delta.changes.length;
    for (const listener of this.#listeners) listener(delta);
    return delta;
  }
}
