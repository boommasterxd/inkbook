import { RENDER_BANDS, type RenderBand } from "../../../domain/commands/render-bands";
import type { Bounds } from "../../../domain/geometry/primitives";
import type { MutableSceneInstrumentation, SceneStorePort } from "../types";
import {
  mergeVisibleBand,
  refreshVisibleRanks,
  sortVisibleBand,
  retainedVisibleOrderStable,
} from "./visibility-order";
import { containsBounds, envelopesOverlap } from "./visibility-bounds";
import { VisibilityEdgeQuery } from "./visibility-edge-query";
import type { VisibilityDelta, VisibilityQueryResult, VisibilityResult } from "./visibility-types";
import { growVisibilityCapacity, growVisibilityMarkers } from "./visibility-markers";
import { VisibilityCandidates } from "./visibility-candidates";
import { VisibilityClassification } from "./visibility-classification";
import { VisibilityRemovalReuse } from "./visibility-removal";
export type { VisibilityDelta, VisibilityQueryResult, VisibilityResult } from "./visibility-types";

export class SceneVisibilityState {
  public readonly removalReuse: VisibilityRemovalReuse;
  readonly #candidates: VisibilityCandidates;
  readonly #classification: VisibilityClassification;
  readonly #bands = Object.fromEntries(
    RENDER_BANDS.map((band) => [
      band,
      {
        ids: [] as (string | undefined)[],
        nextIds: [] as (string | undefined)[],
        newIds: [] as string[],
        capacity: 0,
        count: 0,
        nextCount: 0,
      },
    ]),
  ) as Record<
    RenderBand,
    {
      ids: (string | undefined)[];
      nextIds: (string | undefined)[];
      newIds: string[];
      capacity: number;
      count: number;
      nextCount: number;
    }
  >;
  readonly #freeSlots: number[] = [];
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #slotById = new Map<string, number>();
  readonly #slotIds: (string | undefined)[] = [];
  readonly #enteredIds: string[] = [];
  readonly #exitedIds: string[] = [];
  readonly #edges: VisibilityEdgeQuery;
  readonly #store: SceneStorePort;
  #hasCurrentVisibility = false;
  #currentInvalidated = true;
  #visibilityEnvelope: Bounds | undefined;
  #visibleBands = new Uint8Array(0);
  #visibleEpoch = 0;
  #visibleMarkers = new Uint32Array(0);
  #visibleRanks = new Float64Array(0);
  #retainedRanksStable = true;

  public constructor(store: SceneStorePort, instrumentation: MutableSceneInstrumentation) {
    this.#store = store;
    this.#instrumentation = instrumentation;
    this.#edges = new VisibilityEdgeQuery(store, instrumentation);
    this.#candidates = new VisibilityCandidates(store, instrumentation, (id) => this.slotFor(id));
    this.#classification = new VisibilityClassification(store, instrumentation);
    this.removalReuse = new VisibilityRemovalReuse({
      current: () => this.currentResult(),
      bounds: () => this.#visibilityEnvelope,
      ready: () => !this.#currentInvalidated && this.#candidates.complete,
      contains: (id) => this.contains(id),
      updateRank: (id, rank) => {
        const slot = this.#slotById.get(id);
        if (slot !== undefined) this.#visibleRanks[slot] = rank;
      },
    });
  }

  public query(
    bounds: Bounds,
    retainedBounds: Bounds = bounds,
    allowEdge = true,
    deadline = Infinity,
    now: () => number = () => 0,
    forceRefresh = false,
  ): VisibilityQueryResult {
    const removal = this.removalReuse.advance(bounds, deadline, now, allowEdge && !forceRefresh);
    if (removal === "pending")
      return { changed: false, visibility: this.currentResult(), pending: true };
    if (removal !== undefined) {
      this.#currentInvalidated = false;
      if (removal.exited.length === 0) return { changed: false, visibility: this.currentResult() };
      for (const band of RENDER_BANDS) {
        this.#bands[band].ids = removal[band];
        this.#bands[band].count = removal[band].length;
      }
      return {
        changed: true,
        visibility: this.currentResult(),
        delta: { entered: [], exited: removal.exited },
      };
    }
    if (!forceRefresh && this.canReuseCurrent(bounds, retainedBounds)) {
      this.#edges.release();
      this.#classification.release();
      this.#candidates.cancelPending();
      this.#instrumentation.visibilityHysteresisHits += 1;
      return { changed: false, visibility: this.currentResult() };
    }
    this.removalReuse.invalidate();
    if (allowEdge && this.canQueryEdges(bounds)) {
      this.#classification.release();
      this.#candidates.cancelPending();
      return this.queryEdges(bounds, deadline, now);
    }
    this.#edges.release();
    return this.queryFull(bounds, deadline, now);
  }
  public resortCurrent(): VisibilityResult {
    this.removalReuse.invalidate();
    for (const band of RENDER_BANDS) {
      const { ids, count } = this.#bands[band];
      if (!refreshVisibleRanks(ids, count, band, this.#store, this.#slotById, this.#visibleRanks))
        continue;
      const sorted = ids.slice(0, count);
      this.sortBand(sorted, count, band);
      this.#bands[band].ids = sorted;
    }
    this.removalReuse.ranksFresh();
    return this.currentResult();
  }
  public beginRemoval(): boolean {
    if (!this.removalReuse.begin()) return false;
    this.#currentInvalidated = true;
    return true;
  }
  public releaseId(id: string): void {
    const slot = this.#slotById.get(id);
    if (slot === undefined) return;
    this.#slotById.delete(id);
    this.#slotIds[slot] = undefined;
    this.#candidates.releaseSlot(slot);
    this.#visibleMarkers[slot] = 0;
    this.#visibleBands[slot] = 0;
    this.#visibleRanks[slot] = 0;
    this.#freeSlots.push(slot);
  }
  public contains(id: string): boolean {
    const slot = this.#slotById.get(id);
    return (
      this.#hasCurrentVisibility &&
      slot !== undefined &&
      this.#visibleMarkers[slot] === this.#visibleEpoch
    );
  }
  public queryMemoryUsage(): number {
    return (
      this.#candidates.memoryUsage() +
      this.#edges.memoryUsage() +
      this.#classification.memoryUsage() +
      this.removalReuse.memoryUsage()
    );
  }

  public invalidateCandidates(): void {
    this.removalReuse.invalidate();
    this.#candidates.invalidate();
    this.#classification.release();
  }

  public invalidateStagedOrder(): void {
    this.removalReuse.invalidate();
    this.#classification.release();
    this.#edges.release();
  }

  public invalidateForChanges(
    before: Bounds | null | undefined,
    after: Bounds | null | undefined,
    id?: string,
  ): void;
  public invalidateForChanges(): void;
  public invalidateForChanges(before?: Bounds | null, after?: Bounds | null, id?: string): void {
    this.removalReuse.invalidate();
    this.#currentInvalidated = true;
    this.#edges.release();
    this.#classification.release();
    this.#candidates.invalidateForChanges(before, after, id);
  }

  public release(): void {
    this.removalReuse.invalidate();
    this.#candidates.release();
    this.#classification.release();
    for (const state of Object.values(this.#bands)) {
      state.ids = [];
      state.nextIds = [];
      state.count = state.nextCount = state.capacity = 0;
      state.newIds.length = 0;
    }
    this.#enteredIds.length = 0;
    this.#exitedIds.length = 0;
    this.#edges.release();
    this.#freeSlots.length = 0;
    this.#slotIds.length = 0;
    this.#slotById.clear();
    this.#visibleMarkers = new Uint32Array(0);
    this.#visibleBands = new Uint8Array(0);
    this.#visibleRanks = new Float64Array(0);
    this.#visibleEpoch = 0;
    this.#visibilityEnvelope = undefined;
    this.#hasCurrentVisibility = false;
    this.#currentInvalidated = true;
  }

  private beginVisibleQuery(): number | undefined {
    this.discardNextVisibility();
    this.#retainedRanksStable = true;
    if (this.#visibleEpoch === 0xffff_ffff) {
      this.#visibleMarkers.fill(0);
      this.#visibleEpoch = 1;
      return undefined;
    }
    const previousEpoch = this.#visibleEpoch;
    this.#visibleEpoch += 1;
    return this.#hasCurrentVisibility ? previousEpoch : undefined;
  }

  private currentResult(): VisibilityResult {
    return {
      image: { count: this.#bands.image.count, ids: this.#bands.image.ids },
      highlight: { count: this.#bands.highlight.count, ids: this.#bands.highlight.ids },
      content: { count: this.#bands.content.count, ids: this.#bands.content.ids },
    };
  }

  private canQueryEdges(bounds: Bounds): boolean {
    return (
      this.#hasCurrentVisibility &&
      !this.removalReuse.ranksDirty &&
      !this.#currentInvalidated &&
      this.#visibilityEnvelope !== undefined &&
      envelopesOverlap(this.#visibilityEnvelope, bounds)
    );
  }

  private queryEdges(bounds: Bounds, deadline: number, now: () => number): VisibilityQueryResult {
    const changes = this.#edges.collect(
      this.#visibilityEnvelope!,
      bounds,
      (id) => this.contains(id),
      deadline,
      now,
    );
    if (changes === "pending" || now() >= deadline)
      return { changed: false, visibility: this.currentResult(), pending: true };
    for (const band of RENDER_BANDS) this.#bands[band].newIds.length = 0;
    this.#visibilityEnvelope = bounds;
    if (changes.entered.length + changes.exited.length === 0) {
      this.#edges.release();
      return { changed: false, visibility: this.currentResult() };
    }
    for (const id of changes.exited) {
      const slot = this.#slotById.get(id);
      if (slot !== undefined) this.#visibleMarkers[slot] = 0;
    }
    for (const record of changes.entered) {
      const slot = this.slotFor(record.id);
      this.#visibleMarkers[slot] = this.#visibleEpoch;
      this.#visibleBands[slot] = RENDER_BANDS.indexOf(record.band) + 1;
      this.#visibleRanks[slot] = record.rank;
      this.#bands[record.band].newIds.push(record.id);
    }
    this.#retainedRanksStable = true;
    const delta = this.publishNextVisibility();
    this.#edges.release();
    return { changed: true, visibility: this.currentResult(), ...(delta ? { delta } : {}) };
  }

  private queryFull(bounds: Bounds, deadline: number, now: () => number): VisibilityQueryResult {
    if (!this.#candidates.refresh(bounds, deadline, now))
      return { changed: false, visibility: this.currentResult(), pending: true };
    if (!this.#classification.collect(bounds, this.#candidates, deadline, now))
      return { changed: false, visibility: this.currentResult(), pending: true };
    // Marker/order adoption stays synchronous so a partially adopted epoch is never observable.
    if (now() >= deadline)
      return { changed: false, visibility: this.currentResult(), pending: true };
    const previousEpoch = this.beginVisibleQuery();
    const membershipUnchanged = this.classifyCandidates(previousEpoch);
    this.#classification.release();
    this.#visibilityEnvelope = bounds;
    this.#currentInvalidated = false;
    this.removalReuse.ranksFresh();
    if (membershipUnchanged) {
      this.discardNextVisibility();
      this.#instrumentation.visibilitySortSkips += 1;
      return { changed: false, visibility: this.currentResult() };
    }
    const delta = this.publishNextVisibility();
    return { changed: true, visibility: this.currentResult(), ...(delta ? { delta } : {}) };
  }

  private classifyCandidates(previousEpoch: number | undefined): boolean {
    let unchanged = previousEpoch !== undefined;
    let retainedRanksUnchanged = true;
    for (const record of this.#classification.records) {
      const id = record.id;
      const slot = this.#slotById.get(id);
      if (slot === undefined) continue;
      const bandCode = RENDER_BANDS.indexOf(record.band) + 1;
      const retained =
        previousEpoch !== undefined &&
        this.#visibleMarkers[slot] === previousEpoch &&
        this.#visibleBands[slot] === bandCode;
      const rank = record.rank;
      if (retained && this.#visibleRanks[slot] !== rank) retainedRanksUnchanged = false;
      if (!retained) {
        this.#bands[record.band].newIds.push(id);
      }
      if (previousEpoch === undefined || !retained) {
        unchanged = false;
      }
      this.#visibleMarkers[slot] = this.#visibleEpoch;
      this.#visibleBands[slot] = bandCode;
      this.#visibleRanks[slot] = rank;
      this.pushNextBand(record.band, id);
    }
    // Geometry and camera changes preserve the published order when retained ranks are identical.
    this.#retainedRanksStable = retainedRanksUnchanged || this.retainedOrderStable();
    return (
      this.#retainedRanksStable &&
      unchanged &&
      RENDER_BANDS.every((band) => this.#bands[band].nextCount === this.#bands[band].count)
    );
  }

  private retainedOrderStable(): boolean {
    return RENDER_BANDS.every((band) =>
      retainedVisibleOrderStable(
        this.#bands[band].ids,
        this.#bands[band].count,
        (id) => this.containsInBand(id, band),
        (id) => this.rank(id, band),
      ),
    );
  }

  private pushNextBand(band: RenderBand, id: string): void {
    const state = this.#bands[band];
    state.capacity = growVisibilityCapacity(
      state.nextCount + 1,
      state.capacity,
      this.#instrumentation,
    );
    state.nextIds[state.nextCount++] = id;
  }

  private publishNextVisibility(): VisibilityDelta | undefined {
    this.#enteredIds.length = 0;
    this.#exitedIds.length = 0;
    const deltaEligible = this.#hasCurrentVisibility && this.#retainedRanksStable;
    for (const band of RENDER_BANDS) {
      const state = this.#bands[band];
      if (deltaEligible) {
        state.nextIds.length = 0;
        state.nextCount = mergeVisibleBand(
          state.ids,
          state.count,
          state.newIds,
          state.nextIds,
          (id) => this.retainVisibleId(id, band),
          (left, right) => this.compare(left, right, band),
        );
        for (const id of state.newIds) this.#enteredIds.push(id);
      }
      // Published arrays remain immutable while committed/pending targets reference them.
      state.ids = state.nextIds;
      state.count = state.nextCount;
      state.nextIds = [];
      if (!deltaEligible) this.sortBand(state.ids, state.count, band);
    }
    this.#hasCurrentVisibility = true;
    this.discardNextVisibility();
    return deltaEligible ? { entered: this.#enteredIds, exited: this.#exitedIds } : undefined;
  }

  private retainVisibleId(id: string, band: RenderBand): boolean {
    const retained = this.containsInBand(id, band);
    if (!retained) this.#exitedIds.push(id);
    return retained;
  }

  private discardNextVisibility(): void {
    for (const state of Object.values(this.#bands)) {
      state.nextIds.length = 0;
      state.nextCount = 0;
      state.newIds.length = 0;
    }
  }

  private canReuseCurrent(bounds: Bounds, retainedBounds: Bounds): boolean {
    const previous = this.#visibilityEnvelope;
    return (
      this.#hasCurrentVisibility &&
      !this.#currentInvalidated &&
      previous !== undefined &&
      containsBounds(previous, retainedBounds) &&
      // Bound retained ownership by one additional current reserve on each edge.
      previous.minX >= bounds.minX - (retainedBounds.minX - bounds.minX) &&
      previous.minY >= bounds.minY - (retainedBounds.minY - bounds.minY) &&
      previous.maxX <= bounds.maxX + (bounds.maxX - retainedBounds.maxX) &&
      previous.maxY <= bounds.maxY + (bounds.maxY - retainedBounds.maxY)
    );
  }

  private containsInBand(id: string, band: RenderBand): boolean {
    const slot = this.#slotById.get(id);
    return (
      slot !== undefined &&
      this.#visibleMarkers[slot] === this.#visibleEpoch &&
      this.#visibleBands[slot] === RENDER_BANDS.indexOf(band) + 1
    );
  }

  private sortBand(ids: (string | undefined)[], count: number, band: RenderBand): void {
    sortVisibleBand(ids, count, (left, right) => this.compare(left, right, band));
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
    const bandCode = RENDER_BANDS.indexOf(band) + 1;
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
    if (slot >= this.#visibleMarkers.length) this.growMarkers(slot + 1);
    return slot;
  }

  private growMarkers(required: number): void {
    const grown = growVisibilityMarkers(
      required,
      {
        visible: this.#visibleMarkers,
        bands: this.#visibleBands,
        ranks: this.#visibleRanks,
      },
      this.#instrumentation,
    );
    this.#candidates.ensureMarkerCapacity(grown.visible.length);
    this.#visibleMarkers = grown.visible;
    this.#visibleBands = grown.bands;
    this.#visibleRanks = grown.ranks;
  }
}
