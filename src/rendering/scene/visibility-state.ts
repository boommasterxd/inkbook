import type { RenderBand } from "../../domain/commands/render-bands";
import type { Bounds } from "../../domain/geometry/primitives";
import type { MutableSceneInstrumentation, SceneStorePort } from "./types";
import { mergeVisibleBand, refreshVisibleRanks, sortVisibleBand } from "./visibility-order";
import { containsBounds, envelopesOverlap } from "./visibility-bounds";
import { VisibilityEdgeQuery } from "./visibility-edge-query";
import type { VisibilityDelta, VisibilityQueryResult, VisibilityResult } from "./visibility-types";
import { growVisibilityCapacity, growVisibilityMarkers } from "./visibility-markers";
import { VisibilityCandidates } from "./visibility-candidates";
import { VisibilityClassification } from "./visibility-classification";
export type { VisibilityDelta, VisibilityQueryResult, VisibilityResult } from "./visibility-types";

export class SceneVisibilityState {
  readonly #candidates: VisibilityCandidates;
  readonly #classification: VisibilityClassification;
  #contentIds: (string | undefined)[] = [];
  readonly #freeSlots: number[] = [];
  #highlightIds: (string | undefined)[] = [];
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #slotById = new Map<string, number>();
  readonly #slotIds: (string | undefined)[] = [];
  #nextContentIds: (string | undefined)[] = [];
  #nextHighlightIds: (string | undefined)[] = [];
  readonly #newContentIds: string[] = [];
  readonly #newHighlightIds: string[] = [];
  readonly #enteredIds: string[] = [];
  readonly #exitedIds: string[] = [];
  readonly #edges: VisibilityEdgeQuery;
  readonly #store: SceneStorePort;
  #contentCapacity = 0;
  #contentCount = 0;
  #highlightCapacity = 0;
  #highlightCount = 0;
  #hasCurrentVisibility = false;
  #nextContentCount = 0;
  #nextHighlightCount = 0;
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
  }

  public query(
    bounds: Bounds,
    retainedBounds: Bounds = bounds,
    allowEdge = true,
    deadline = Infinity,
    now: () => number = () => 0,
    forceRefresh = false,
  ): VisibilityQueryResult {
    if (!forceRefresh && this.canReuseCurrent(bounds, retainedBounds)) {
      this.#edges.release();
      this.#classification.release();
      this.#candidates.cancelPending();
      this.#instrumentation.visibilityHysteresisHits += 1;
      return { changed: false, visibility: this.currentResult() };
    }
    if (allowEdge && this.canQueryEdges(bounds)) {
      this.#classification.release();
      this.#candidates.cancelPending();
      return this.queryEdges(bounds, deadline, now);
    }
    this.#edges.release();
    return this.queryFull(bounds, deadline, now);
  }

  public resortCurrent(): VisibilityResult {
    this.#highlightIds = this.#highlightIds.slice(0, this.#highlightCount);
    this.#contentIds = this.#contentIds.slice(0, this.#contentCount);
    refreshVisibleRanks(
      this.#highlightIds,
      this.#highlightCount,
      "highlight",
      this.#store,
      this.#slotById,
      this.#visibleRanks,
    );
    refreshVisibleRanks(
      this.#contentIds,
      this.#contentCount,
      "content",
      this.#store,
      this.#slotById,
      this.#visibleRanks,
    );
    this.sortBand(this.#highlightIds, this.#highlightCount, "highlight");
    this.sortBand(this.#contentIds, this.#contentCount, "content");
    return this.currentResult();
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
      this.#classification.memoryUsage()
    );
  }

  public invalidateCandidates(): void {
    this.#candidates.invalidate();
    this.#classification.release();
  }

  public invalidateStagedOrder(): void {
    this.#classification.release();
    this.#edges.release();
  }

  public invalidateForChanges(
    before: Bounds | null | undefined,
    after: Bounds | null | undefined,
  ): void;
  public invalidateForChanges(): void;
  public invalidateForChanges(before?: Bounds | null, after?: Bounds | null): void {
    this.#currentInvalidated = true;
    this.#edges.release();
    this.#classification.release();
    this.#candidates.invalidateForChanges(before, after);
  }

  public release(): void {
    this.#candidates.release();
    this.#classification.release();
    this.#contentIds = [];
    this.#highlightIds = [];
    this.#nextContentIds = [];
    this.#nextHighlightIds = [];
    this.#contentCount = 0;
    this.#highlightCount = 0;
    this.#nextContentCount = 0;
    this.#nextHighlightCount = 0;
    this.#contentCapacity = 0;
    this.#highlightCapacity = 0;
    this.#newContentIds.length = 0;
    this.#newHighlightIds.length = 0;
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
    this.#newContentIds.length = 0;
    this.#newHighlightIds.length = 0;
    this.#retainedRanksStable = true;
    this.#nextContentIds.length = 0;
    this.#nextHighlightIds.length = 0;
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

  private currentResult(): VisibilityResult {
    return {
      content: { count: this.#contentCount, ids: this.#contentIds },
      highlight: { count: this.#highlightCount, ids: this.#highlightIds },
    };
  }

  private canQueryEdges(bounds: Bounds): boolean {
    return (
      this.#hasCurrentVisibility &&
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
    this.#newContentIds.length = 0;
    this.#newHighlightIds.length = 0;
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
      this.#visibleBands[slot] = record.band === "highlight" ? 1 : 2;
      this.#visibleRanks[slot] = record.rank;
      (record.band === "highlight" ? this.#newHighlightIds : this.#newContentIds).push(record.id);
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
    for (const record of this.#classification.records) {
      const id = record.id;
      const slot = this.#slotById.get(id);
      if (slot === undefined) continue;
      const bandCode = record.band === "highlight" ? 1 : 2;
      const retained =
        previousEpoch !== undefined &&
        this.#visibleMarkers[slot] === previousEpoch &&
        this.#visibleBands[slot] === bandCode;
      if (!retained) {
        (record.band === "highlight" ? this.#newHighlightIds : this.#newContentIds).push(id);
      } else if (this.#visibleRanks[slot] !== record.rank) {
        this.#retainedRanksStable = false;
      }
      if (previousEpoch === undefined || !retained) {
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

  private publishNextVisibility(): VisibilityDelta | undefined {
    this.#enteredIds.length = 0;
    this.#exitedIds.length = 0;
    const deltaEligible = this.#hasCurrentVisibility && this.#retainedRanksStable;
    const incremental = deltaEligible;
    if (incremental) {
      this.#nextContentIds.length = 0;
      this.#nextHighlightIds.length = 0;
      this.#nextContentCount = mergeVisibleBand(
        this.#contentIds,
        this.#contentCount,
        this.#newContentIds,
        this.#nextContentIds,
        (id) => this.retainVisibleId(id, "content"),
        (left, right) => this.compare(left, right, "content"),
      );
      this.#nextHighlightCount = mergeVisibleBand(
        this.#highlightIds,
        this.#highlightCount,
        this.#newHighlightIds,
        this.#nextHighlightIds,
        (id) => this.retainVisibleId(id, "highlight"),
        (left, right) => this.compare(left, right, "highlight"),
      );
      for (const id of this.#newHighlightIds) this.#enteredIds.push(id);
      for (const id of this.#newContentIds) this.#enteredIds.push(id);
    }
    // Published arrays remain immutable while committed/pending targets reference them.
    this.#contentIds = this.#nextContentIds;
    this.#contentCount = this.#nextContentCount;
    this.#highlightIds = this.#nextHighlightIds;
    this.#highlightCount = this.#nextHighlightCount;
    this.#nextContentIds = [];
    this.#nextHighlightIds = [];
    if (!incremental) {
      this.sortBand(this.#highlightIds, this.#highlightCount, "highlight");
      this.sortBand(this.#contentIds, this.#contentCount, "content");
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
    this.#nextContentIds.length = 0;
    this.#nextHighlightIds.length = 0;
    this.#nextContentCount = 0;
    this.#nextHighlightCount = 0;
    this.#newContentIds.length = 0;
    this.#newHighlightIds.length = 0;
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
      this.#visibleBands[slot] === (band === "highlight" ? 1 : 2)
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

  private ensureContentCapacity(required: number): void {
    this.#contentCapacity = growVisibilityCapacity(
      required,
      this.#contentCapacity,
      this.#instrumentation,
    );
  }

  private ensureHighlightCapacity(required: number): void {
    this.#highlightCapacity = growVisibilityCapacity(
      required,
      this.#highlightCapacity,
      this.#instrumentation,
    );
  }
}
