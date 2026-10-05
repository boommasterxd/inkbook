import { VersionedCache } from "../../domain/cache/versioned-cache";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";
import {
  setMountedElementFade,
  setMountedElementMotion,
  updateMountedPaint,
  updatePreviewTransform,
  firstPath,
  removeMountedElement,
  removeMountedElementNode,
  type MountedSceneElement,
} from "./mounted-element";
import { DETACHED_ELEMENT_CACHE_MAX_BYTES } from "./constants";
import { ConnectedRootOrder } from "./connected-root-order";
import type { ScenePublicationBudget } from "./mount-slice";

/** One LRU owns detached and connected offscreen roots under the same resource limits. */
export class DetachedSceneElementCache extends VersionedCache<MountedSceneElement> {
  readonly #owned = new Map<string, MountedSceneElement>();
  readonly #order = new ConnectedRootOrder();
  readonly #removing = new Map<string, MountedSceneElement>();
  readonly #reserved = new Map<string, MountedSceneElement>();
  readonly #invalidReservations = new Set<string>();
  #reservedBytes = 0;
  #reservedRoots = 0;
  #removingBytes = 0;
  #removingRoots = 0;
  #taking = false;
  #roots = 0;
  #rootEvictions = 0;
  public constructor(maximumBytes = DETACHED_ELEMENT_CACHE_MAX_BYTES) {
    // Every entry accounts for positive bytes, so this LRU count cannot constrain byte admission.
    super(maximumBytes, maximumBytes, (_id, entry) => this.forget(entry));
    this.maximumBytes = maximumBytes;
  }

  private readonly maximumBytes: number;

  public isConnected(id: string): boolean {
    const entry = this.#owned.get(id) ?? this.#reserved.get(id);
    return entry !== undefined && firstPath(entry).parentNode !== null;
  }

  public retain(entry: MountedSceneElement): boolean {
    if (this.#reserved.get(entry.id) === entry) return this.returnReservation(entry);
    // Previews are transient geometry; they must never become a committed revisit.
    if (entry.displayedPathParts !== entry.pathParts || !this.retentionEnabled) return false;
    if (this.#owned.get(entry.id) === entry) return true;
    const bytes = detachedElementBytes(entry);
    const roots = entry.group === null ? entry.paths.length : 1;
    if (bytes > this.maximumBytes) return false;
    this.invalidate(entry.id);
    if (this.retainedBytes + bytes > this.maximumBytes) {
      this.reserveCapacity(bytes);
      if (this.#removing.size > 0) return false;
    }
    while (this.retainedBytes + bytes > this.maximumBytes) {
      const oldest = this.#owned.keys().next().value;
      if (oldest === undefined) return false;
      this.invalidate(oldest);
      this.#rootEvictions += 1;
      if (this.#removing.size > 0) return false;
    }
    this.#owned.set(entry.id, entry);
    this.#roots += roots;
    this.retainCached(entry.id, entry.geometryVersion, entry, bytes);
    if (
      this.#owned.has(entry.id) &&
      firstPath(entry).parentNode !== null &&
      !this.#order.has(entry)
    )
      this.registerMounted(entry);
    return this.#owned.has(entry.id);
  }

  public retainConnected(entry: MountedSceneElement, store: SceneStorePort): boolean {
    if (!this.#order.hasCurrent(entry)) this.registerMounted(entry, store);
    return this.retain(entry);
  }

  /** Transfers unchanged, proven connected roots without preparing a DOM mutation. */
  public restoreConnected(record: SceneElementRecord): MountedSceneElement | undefined {
    const entry = this.#owned.get(record.id);
    if (
      entry === undefined ||
      entry.geometryVersion !== record.geometryVersion ||
      entry.paintVersion !== record.paintVersion ||
      entry.band !== record.band ||
      entry.committedRank !== record.rank ||
      entry.detachedPathCount !== 0 ||
      entry.displayedPathParts !== entry.pathParts ||
      entry.appliedPreviewTransform !== null ||
      entry.previewStrokeWidthScale !== null ||
      entry.fadeActive ||
      entry.motionActive ||
      !this.#order.hasCurrent(entry) ||
      firstPath(entry).parentNode === null
    )
      return undefined;
    this.#taking = true;
    this.takeCached(record.id, record.geometryVersion);
    this.#taking = false;
    this.commitReservation(entry);
    entry.displayedElement = record.element;
    entry.rank = record.rank;
    return entry;
  }

  /** Includes active roots so newly offscreen anchors are correct before exit bookkeeping. */
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
    return this.#roots + this.#removingRoots + this.#reservedRoots;
  }

  private get retainedBytes(): number {
    return this.cachedBytes + this.#removingBytes + this.#reservedBytes;
  }

  /** Publication transfers a staged connected revisit to logical mounted ownership. */
  public commitReservation(entry: MountedSceneElement): void {
    if (this.#reserved.get(entry.id) !== entry) return;
    this.#reserved.delete(entry.id);
    this.#invalidReservations.delete(entry.id);
    this.#reservedRoots -= entry.group === null ? entry.paths.length : 1;
    this.#reservedBytes -= detachedElementBytes(entry);
  }

  public override invalidate(id: string): void {
    if (this.#reserved.has(id)) this.#invalidReservations.add(id);
    super.invalidate(id);
  }

  public get hasPendingCleanup(): boolean {
    return this.#removing.size > 0;
  }

  public isPendingRemoval(id: string): boolean {
    return this.#removing.has(id);
  }

  public isReserved(id: string): boolean {
    return this.#reserved.has(id);
  }

  public flushEvictions(
    deadline: number,
    now: () => number,
    budget: ScenePublicationBudget,
  ): boolean {
    let removed = 0;
    for (const entry of this.#removing.values()) {
      while (true) {
        if ((budget.remainingRemovals ?? 64) === 0 || (removed > 0 && now() >= deadline))
          return true;
        budget.remainingRemovals = (budget.remainingRemovals ?? 64) - 1;
        this.#removingRoots -= 1;
        removed += 1;
        if (!removeMountedElementNode(entry)) continue;
        this.#removing.delete(entry.id);
        this.#removingBytes -= detachedElementBytes(entry);
        break;
      }
    }
    return false;
  }

  public dispose(): void {
    this.release();
    for (const entry of this.#reserved.values()) this.returnReservation(entry, true);
    for (const entry of this.#removing.values()) removeMountedElement(entry);
    this.#removing.clear();
    this.#removingBytes = 0;
    this.#removingRoots = 0;
    this.#order.clear();
  }

  public override statistics(): ReturnType<VersionedCache<MountedSceneElement>["statistics"]> {
    const statistics = super.statistics();
    return {
      ...statistics,
      bytes: this.retainedBytes,
      evictions: statistics.evictions + this.#rootEvictions,
    };
  }

  public override resetStatistics(): void {
    super.resetStatistics();
    this.#rootEvictions = 0;
  }

  public override release(): void {
    for (const id of this.#reserved.keys()) this.#invalidReservations.add(id);
    super.release();
  }

  public take(
    record: SceneElementRecord,
    instrumentation: MutableSceneInstrumentation,
  ): MountedSceneElement | undefined {
    const cached = this.#owned.get(record.id);
    if (cached !== undefined && cached.band !== record.band && this.isConnected(record.id))
      this.invalidate(record.id);
    this.#taking = cached?.geometryVersion === record.geometryVersion;
    const entry = this.takeCached(record.id, record.geometryVersion);
    this.#taking = false;
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
    return this.retainedBytes + this.#order.memoryUsage();
  }

  private forget(entry: MountedSceneElement): void {
    if (!this.#owned.delete(entry.id)) return;
    this.#roots -= entry.group === null ? entry.paths.length : 1;
    if (this.#taking && firstPath(entry).parentNode !== null) {
      this.#reserved.set(entry.id, entry);
      this.#reservedBytes += detachedElementBytes(entry);
      this.#reservedRoots += entry.group === null ? entry.paths.length : 1;
    } else if (!this.#taking) {
      this.unregisterMounted(entry.id);
      if (firstPath(entry).parentNode !== null) {
        this.#removing.set(entry.id, entry);
        this.#removingBytes += detachedElementBytes(entry);
        this.#removingRoots += entry.group === null ? entry.paths.length : 1;
      }
    }
  }

  private returnReservation(entry: MountedSceneElement, retire = false): boolean {
    retire ||=
      this.#invalidReservations.has(entry.id) ||
      !this.retentionEnabled ||
      entry.displayedPathParts !== entry.pathParts;
    this.commitReservation(entry);
    this.#owned.set(entry.id, entry);
    this.#roots += entry.group === null ? entry.paths.length : 1;
    if (retire) this.forget(entry);
    else this.retainCached(entry.id, entry.geometryVersion, entry, detachedElementBytes(entry));
    return true;
  }

  private reserveCapacity(bytes: number): void {
    const byteTarget = Math.max(0, this.maximumBytes - bytes);
    while (this.cachedBytes > byteTarget && this.#removingRoots < 64) {
      const oldest = this.#owned.keys().next().value;
      if (oldest === undefined) break;
      this.invalidate(oldest);
      this.#rootEvictions += 1;
    }
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
