import { VersionedCache } from "../../../domain/cache/versioned-cache";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "../types";
import {
  setMountedElementFade,
  setMountedElementMotion,
  updateMountedPaint,
  updatePreviewTransform,
  type MountedSceneElement,
} from "./mounted-element";
import { DETACHED_ELEMENT_CACHE_MAX_BYTES } from "../constants";
import { ConnectedRootOrder } from "./connected-root-order";

/** Owns only complete detached committed roots, independently of mounted order. */
export class DetachedSceneElementCache extends VersionedCache<MountedSceneElement> {
  readonly #owned = new Map<string, MountedSceneElement>();
  readonly #order = new ConnectedRootOrder();
  #roots = 0;
  #rootEvictions = 0;

  public constructor(private readonly maximumBytes = DETACHED_ELEMENT_CACHE_MAX_BYTES) {
    // Positive entry bytes bound entry count without an independent count eviction.
    super(maximumBytes, maximumBytes, (_id, entry) => this.forget(entry));
  }

  public retain(entry: MountedSceneElement, isNeeded?: (id: string) => boolean): boolean {
    const connected =
      entry.group === null
        ? entry.paths.some(({ node }) => node.parentNode !== null)
        : entry.group.parentNode !== null;
    // Partial exits and transient preview geometry cannot become committed revisits.
    if (connected || entry.displayedPathParts !== entry.pathParts || !this.retentionEnabled)
      return false;
    if (this.#owned.get(entry.id) === entry) return true;
    const bytes = detachedElementBytes(entry);
    if (bytes > this.maximumBytes) return false;
    this.invalidate(entry.id);
    while (this.cachedBytes + bytes > this.maximumBytes) {
      const oldest = this.#owned.keys().next().value;
      if (oldest === undefined || isNeeded?.(oldest)) return false;
      this.invalidate(oldest);
      this.#rootEvictions += 1;
    }
    this.#owned.set(entry.id, entry);
    this.#roots += entry.group === null ? entry.paths.length : 1;
    this.retainCached(entry.id, entry.geometryVersion, entry, bytes);
    return this.#owned.has(entry.id);
  }

  public registerMounted(entry: MountedSceneElement, store?: SceneStorePort): void {
    this.#order.add(entry, store);
  }

  public unregisterMounted(id: string): void {
    this.#order.remove(id);
  }

  public invalidateRanks(): void {
    this.#order.invalidateRanks();
  }

  public successor(
    record: Pick<SceneElementRecord, "id" | "rank" | "band">,
  ): MountedSceneElement | undefined {
    return this.#order.successor(record);
  }

  public get retainedRoots(): number {
    return this.#roots;
  }

  public dispose(): void {
    this.release();
    this.#order.clear();
  }

  public override statistics(): ReturnType<VersionedCache<MountedSceneElement>["statistics"]> {
    const statistics = super.statistics();
    return { ...statistics, evictions: statistics.evictions + this.#rootEvictions };
  }

  public override resetStatistics(): void {
    super.resetStatistics();
    this.#rootEvictions = 0;
  }

  public take(
    record: SceneElementRecord,
    instrumentation: MutableSceneInstrumentation,
  ): MountedSceneElement | undefined {
    const entry = this.takeCached(record.id, record.geometryVersion);
    if (entry === undefined) return undefined;
    if (entry.fadeActive) setMountedElementFade(entry, null);
    setMountedElementMotion(entry, null);
    if (entry.paintVersion !== record.paintVersion)
      updateMountedPaint(entry, record, entry.pathParts, instrumentation);
    entry.displayedElement = record.element;
    entry.band = record.band;
    entry.rank = record.rank;
    entry.committedOrderEpoch = 0;
    entry.detachedPathCount = 0;
    updatePreviewTransform(entry, null, 0, null, instrumentation);
    return entry;
  }

  public memoryUsage(): number {
    return this.cachedBytes + this.#order.memoryUsage();
  }

  private forget(entry: MountedSceneElement): void {
    if (!this.#owned.delete(entry.id)) return;
    this.#roots -= entry.group === null ? entry.paths.length : 1;
  }
}

/** Conservative owned-storage estimate; browser allocator overhead is implementation-specific. */
function detachedElementBytes(entry: MountedSceneElement): number {
  const elementBytes =
    entry.displayedElement.kind === "stroke" ? entry.displayedElement.points.length * 8 : 256;
  return (
    576 +
    entry.id.length * 2 +
    elementBytes +
    (entry.group === null ? 0 : 512) +
    entry.paths.reduce((total, path) => total + 512 + path.appliedD.length * 2, 0)
  );
}
