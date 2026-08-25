import type { RenderBand } from "../../domain/commands/render-bands";
import type { Bounds } from "../../domain/geometry/primitives";
import type { MutableSceneInstrumentation, SceneStorePort, SpatialQuerySink } from "./types";

export interface BandVisibility {
  readonly count: number;
  readonly ids: readonly (string | undefined)[];
}

export interface VisibilityResult {
  readonly content: BandVisibility;
  readonly highlight: BandVisibility;
}

export interface VisibilityQueryResult {
  readonly changed: boolean;
  readonly visibility: VisibilityResult;
}

export class SceneVisibilityState implements SpatialQuerySink {
  readonly #candidateIds: (string | undefined)[] = [];
  readonly #contentIds: (string | undefined)[] = [];
  readonly #freeSlots: number[] = [];
  readonly #highlightIds: (string | undefined)[] = [];
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #slotById = new Map<string, number>();
  readonly #slotIds: (string | undefined)[] = [];
  readonly #nextContentIds: (string | undefined)[] = [];
  readonly #nextHighlightIds: (string | undefined)[] = [];
  readonly #store: SceneStorePort;
  #candidateCapacity = 0;
  #candidateCount = 0;
  #contentCapacity = 0;
  #contentCount = 0;
  #candidateEpoch = 0;
  #candidateBounds: Bounds | undefined;
  #candidateKey: string | undefined;
  #highlightCapacity = 0;
  #highlightCount = 0;
  #hasCurrentVisibility = false;
  #nextContentCount = 0;
  #nextHighlightCount = 0;
  #candidateMarkers = new Uint32Array(0);
  #currentInvalidated = true;
  #visibilityEnvelope: Bounds | undefined;
  #visibleBands = new Uint8Array(0);
  #visibleEpoch = 0;
  #visibleMarkers = new Uint32Array(0);
  #visibleRanks = new Float64Array(0);

  public constructor(store: SceneStorePort, instrumentation: MutableSceneInstrumentation) {
    this.#store = store;
    this.#instrumentation = instrumentation;
  }

  public add(id: string): void {
    const slot = this.slotFor(id);
    if (this.#candidateMarkers[slot] === this.#candidateEpoch) return;
    this.#candidateMarkers[slot] = this.#candidateEpoch;
    this.ensureCandidateCapacity(this.#candidateCount + 1);
    this.#candidateIds[this.#candidateCount] = id;
    this.#candidateCount += 1;
  }

  public query(bounds: Bounds, retainedBounds: Bounds = bounds): VisibilityQueryResult {
    if (this.canReuseCurrent(retainedBounds)) {
      this.#instrumentation.visibilityHysteresisHits += 1;
      return { changed: false, visibility: this.currentResult() };
    }
    this.refreshCandidates(bounds);
    const previousEpoch = this.beginVisibleQuery();
    const membershipUnchanged = this.classifyCandidates(bounds, previousEpoch);
    this.#visibilityEnvelope = bounds;
    this.#currentInvalidated = false;
    if (membershipUnchanged) {
      this.discardNextVisibility();
      this.#instrumentation.visibilitySortSkips += 1;
      return { changed: false, visibility: this.currentResult() };
    }
    this.publishNextVisibility();
    return { changed: true, visibility: this.currentResult() };
  }

  public resortCurrent(): VisibilityResult {
    this.refreshRanks(this.#highlightIds, this.#highlightCount, "highlight");
    this.refreshRanks(this.#contentIds, this.#contentCount, "content");
    this.sortBand(this.#highlightIds, this.#highlightCount, "highlight");
    this.sortBand(this.#contentIds, this.#contentCount, "content");
    return this.currentResult();
  }

  public releaseId(id: string): void {
    const slot = this.#slotById.get(id);
    if (slot === undefined) return;
    this.#slotById.delete(id);
    this.#slotIds[slot] = undefined;
    this.#candidateMarkers[slot] = 0;
    this.#visibleMarkers[slot] = 0;
    this.#visibleBands[slot] = 0;
    this.#visibleRanks[slot] = 0;
    this.#freeSlots.push(slot);
  }

  public contains(id: string): boolean {
    const slot = this.#slotById.get(id);
    return slot !== undefined && this.#visibleMarkers[slot] === this.#visibleEpoch;
  }

  public invalidateCandidates(): void {
    this.#candidateBounds = undefined;
    this.#candidateKey = undefined;
  }

  public invalidateForChanges(
    before: Bounds | null | undefined,
    after: Bounds | null | undefined,
  ): void;
  public invalidateForChanges(): void;
  public invalidateForChanges(before?: Bounds | null, after?: Bounds | null): void {
    this.#currentInvalidated = true;
    const range = this.#candidateBounds;
    if (
      range !== undefined &&
      before !== undefined &&
      after !== undefined &&
      relevantToRange(before, range) === relevantToRange(after, range)
    ) {
      return;
    }
    this.invalidateCandidates();
  }

  public release(): void {
    this.clearReferences(this.#candidateIds, this.#candidateCount);
    this.clearReferences(this.#contentIds, this.#contentCount);
    this.clearReferences(this.#highlightIds, this.#highlightCount);
    this.clearReferences(this.#nextContentIds, this.#nextContentCount);
    this.clearReferences(this.#nextHighlightIds, this.#nextHighlightCount);
    this.#candidateIds.length = 0;
    this.#contentIds.length = 0;
    this.#highlightIds.length = 0;
    this.#nextContentIds.length = 0;
    this.#nextHighlightIds.length = 0;
    this.#freeSlots.length = 0;
    this.#slotIds.length = 0;
    this.#slotById.clear();
    this.#candidateMarkers = new Uint32Array(0);
    this.#visibleMarkers = new Uint32Array(0);
    this.#visibleBands = new Uint8Array(0);
    this.#visibleRanks = new Float64Array(0);
    this.#candidateBounds = undefined;
    this.#candidateKey = undefined;
    this.#visibilityEnvelope = undefined;
    this.#hasCurrentVisibility = false;
    this.#currentInvalidated = true;
  }

  private beginVisibleQuery(): number | undefined {
    this.clearReferences(this.#nextContentIds, this.#nextContentCount);
    this.clearReferences(this.#nextHighlightIds, this.#nextHighlightCount);
    this.#nextContentCount = 0;
    this.#nextHighlightCount = 0;
    if (this.#visibleEpoch === 0xffff_ffff) {
      this.#visibleMarkers.fill(0);
      this.#visibleEpoch = 1;
      return undefined;
    }
    const previousEpoch = this.#visibleEpoch;
    this.#visibleEpoch += 1;
    return this.#hasCurrentVisibility ? previousEpoch : undefined;
  }

  private refreshCandidates(bounds: Bounds): void {
    const range = cellRange(bounds);
    if (range.key === this.#candidateKey) {
      this.#instrumentation.visibilityCandidateCacheHits += 1;
      return;
    }
    this.clearReferences(this.#candidateIds, this.#candidateCount);
    this.#candidateCount = 0;
    if (this.#candidateEpoch === 0xffff_ffff) {
      this.#candidateMarkers.fill(0);
      this.#candidateEpoch = 1;
    } else this.#candidateEpoch += 1;
    this.#candidateBounds = range.bounds;
    this.#candidateKey = range.key;
    this.#instrumentation.spatialQueries += 1;
    this.#store.query(range.bounds, this);
  }

  private currentResult(): VisibilityResult {
    return {
      content: { count: this.#contentCount, ids: this.#contentIds },
      highlight: { count: this.#highlightCount, ids: this.#highlightIds },
    };
  }

  private classifyCandidates(bounds: Bounds, previousEpoch: number | undefined): boolean {
    let unchanged = previousEpoch !== undefined;
    for (let index = 0; index < this.#candidateCount; index += 1) {
      const id = this.#candidateIds[index];
      if (id === undefined) continue;
      const record = this.#store.get(id);
      if (record === undefined) {
        this.releaseId(id);
        continue;
      }
      if (!intersects(bounds, record.bounds)) continue;
      const slot = this.#slotById.get(id);
      if (slot === undefined) continue;
      const bandCode = record.band === "highlight" ? 1 : 2;
      if (
        previousEpoch === undefined ||
        this.#visibleMarkers[slot] !== previousEpoch ||
        this.#visibleBands[slot] !== bandCode
      ) {
        unchanged = false;
      }
      this.#visibleMarkers[slot] = this.#visibleEpoch;
      this.#visibleBands[slot] = bandCode;
      this.#visibleRanks[slot] = record.rank;
      this.pushNextBand(record.band, id);
    }
    return (
      unchanged &&
      this.#nextContentCount === this.#contentCount &&
      this.#nextHighlightCount === this.#highlightCount
    );
  }

  private pushNextBand(band: RenderBand, id: string): void {
    if (band === "highlight") {
      this.ensureHighlightCapacity(this.#nextHighlightCount + 1);
      this.#nextHighlightIds[this.#nextHighlightCount] = id;
      this.#nextHighlightCount += 1;
      return;
    }
    this.ensureContentCapacity(this.#nextContentCount + 1);
    this.#nextContentIds[this.#nextContentCount] = id;
    this.#nextContentCount += 1;
  }

  private publishNextVisibility(): void {
    this.clearReferences(this.#contentIds, this.#contentCount);
    this.clearReferences(this.#highlightIds, this.#highlightCount);
    this.#contentCount = copyReferences(
      this.#nextContentIds,
      this.#nextContentCount,
      this.#contentIds,
    );
    this.#highlightCount = copyReferences(
      this.#nextHighlightIds,
      this.#nextHighlightCount,
      this.#highlightIds,
    );
    this.sortBand(this.#highlightIds, this.#highlightCount, "highlight");
    this.sortBand(this.#contentIds, this.#contentCount, "content");
    this.#hasCurrentVisibility = true;
    this.discardNextVisibility();
  }

  private discardNextVisibility(): void {
    this.clearReferences(this.#nextContentIds, this.#nextContentCount);
    this.clearReferences(this.#nextHighlightIds, this.#nextHighlightCount);
    this.#nextContentCount = 0;
    this.#nextHighlightCount = 0;
  }

  private canReuseCurrent(retainedBounds: Bounds): boolean {
    return (
      this.#hasCurrentVisibility &&
      !this.#currentInvalidated &&
      this.#visibilityEnvelope !== undefined &&
      containsBounds(this.#visibilityEnvelope, retainedBounds)
    );
  }

  private sortBand(ids: (string | undefined)[], count: number, band: RenderBand): void {
    for (let start = Math.floor(count / 2) - 1; start >= 0; start -= 1) {
      this.siftDown(ids, start, count, band);
    }
    for (let end = count - 1; end > 0; end -= 1) {
      const first = ids[0];
      ids[0] = ids[end];
      ids[end] = first;
      this.siftDown(ids, 0, end, band);
    }
  }

  private refreshRanks(
    ids: readonly (string | undefined)[],
    count: number,
    band: RenderBand,
  ): void {
    for (let index = 0; index < count; index += 1) {
      const id = ids[index];
      if (id === undefined) continue;
      const slot = this.#slotById.get(id);
      if (slot === undefined) continue;
      const record = this.#store.get(id);
      if (record?.band === band) this.#visibleRanks[slot] = record.rank;
    }
  }

  private siftDown(
    ids: (string | undefined)[],
    start: number,
    count: number,
    band: RenderBand,
  ): void {
    let root = start;
    while (root * 2 + 1 < count) {
      const left = root * 2 + 1;
      const right = left + 1;
      const child = right < count && this.compare(ids[right], ids[left], band) > 0 ? right : left;
      if (this.compare(ids[child], ids[root], band) <= 0) return;
      const value = ids[root];
      ids[root] = ids[child];
      ids[child] = value;
      root = child;
    }
  }

  private compare(left: string | undefined, right: string | undefined, band: RenderBand): number {
    if (left === undefined) return right === undefined ? 0 : 1;
    if (right === undefined) return -1;
    const rankDifference = this.rank(left, band) - this.rank(right, band);
    return rankDifference === 0 ? left.localeCompare(right) : rankDifference;
  }

  private rank(id: string, band: RenderBand): number {
    const slot = this.#slotById.get(id);
    if (slot === undefined) return Number.MAX_SAFE_INTEGER;
    const bandCode = band === "highlight" ? 1 : 2;
    return this.#visibleBands[slot] === bandCode
      ? this.#visibleRanks[slot]!
      : Number.MAX_SAFE_INTEGER;
  }

  private slotFor(id: string): number {
    const existing = this.#slotById.get(id);
    if (existing !== undefined) return existing;
    const slot = this.#freeSlots.pop() ?? this.#slotIds.length;
    this.#slotById.set(id, slot);
    this.#slotIds[slot] = id;
    if (slot >= this.#candidateMarkers.length) this.growMarkers(slot + 1);
    return slot;
  }

  private growMarkers(required: number): void {
    let capacity = Math.max(16, this.#candidateMarkers.length || 1);
    while (capacity < required) capacity *= 2;
    const candidateMarkers = new Uint32Array(capacity);
    candidateMarkers.set(this.#candidateMarkers);
    this.#candidateMarkers = candidateMarkers;
    const visibleMarkers = new Uint32Array(capacity);
    visibleMarkers.set(this.#visibleMarkers);
    this.#visibleMarkers = visibleMarkers;
    const visibleBands = new Uint8Array(capacity);
    visibleBands.set(this.#visibleBands);
    this.#visibleBands = visibleBands;
    const visibleRanks = new Float64Array(capacity);
    visibleRanks.set(this.#visibleRanks);
    this.#visibleRanks = visibleRanks;
    this.#instrumentation.collectionAllocations += 1;
  }

  private ensureCandidateCapacity(required: number): void {
    this.#candidateCapacity = this.ensureCapacity(required, this.#candidateCapacity);
  }

  private ensureContentCapacity(required: number): void {
    this.#contentCapacity = this.ensureCapacity(required, this.#contentCapacity);
  }

  private ensureHighlightCapacity(required: number): void {
    this.#highlightCapacity = this.ensureCapacity(required, this.#highlightCapacity);
  }

  private ensureCapacity(required: number, current: number): number {
    if (required <= current) return current;
    let capacity = Math.max(16, current || 1);
    while (capacity < required) capacity *= 2;
    this.#instrumentation.collectionAllocations += 1;
    return capacity;
  }

  private clearReferences(values: (string | undefined)[], count: number): void {
    for (let index = 0; index < count; index += 1) values[index] = undefined;
  }
}

const SPATIAL_CELL_SIZE = 256;

function cellRange(bounds: Bounds): { readonly bounds: Bounds; readonly key: string } {
  const minX = Math.floor(bounds.minX / SPATIAL_CELL_SIZE);
  const minY = Math.floor(bounds.minY / SPATIAL_CELL_SIZE);
  const maxX = Math.floor(bounds.maxX / SPATIAL_CELL_SIZE);
  const maxY = Math.floor(bounds.maxY / SPATIAL_CELL_SIZE);
  return {
    bounds: {
      minX: minX * SPATIAL_CELL_SIZE,
      minY: minY * SPATIAL_CELL_SIZE,
      maxX: (maxX + 1) * SPATIAL_CELL_SIZE,
      maxY: (maxY + 1) * SPATIAL_CELL_SIZE,
    },
    key: `${String(minX)}:${String(minY)}:${String(maxX)}:${String(maxY)}`,
  };
}

function intersects(left: Bounds, right: Bounds): boolean {
  return (
    left.minX <= right.maxX &&
    left.maxX >= right.minX &&
    left.minY <= right.maxY &&
    left.maxY >= right.minY
  );
}

function containsBounds(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

function copyReferences(
  source: readonly (string | undefined)[],
  count: number,
  target: (string | undefined)[],
): number {
  for (let index = 0; index < count; index += 1) target[index] = source[index];
  return count;
}

function relevantToRange(bounds: Bounds | null, range: Bounds): boolean {
  return bounds !== null && intersects(bounds, range);
}
