import type { RenderBand } from "../../domain/commands/render-bands";
import type { Bounds } from "../../domain/geometry/primitives";
import type { MutableSceneInstrumentation, SceneStorePort } from "./types";
import {
  clearVisibleReferences,
  copyVisibleReferences,
  mergeVisibleBand,
  refreshVisibleRanks,
  sortVisibleBand,
} from "./visibility-order";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "./constants";
import { containsBounds, envelopesOverlap, intersects } from "./visibility-bounds";
import { VisibilityEdgeQuery } from "./visibility-edge-query";
import type { VisibilityDelta, VisibilityQueryResult, VisibilityResult } from "./visibility-types";
import { growVisibilityCapacity, growVisibilityMarkers } from "./visibility-markers";
import { VisibilityCandidates } from "./visibility-candidates";
export type {
  BandVisibility,
  VisibilityDelta,
  VisibilityQueryResult,
  VisibilityResult,
} from "./visibility-types";

export class SceneVisibilityState {
  readonly #candidates: VisibilityCandidates;
  readonly #contentIds: (string | undefined)[] = [];
  readonly #freeSlots: number[] = [];
  readonly #highlightIds: (string | undefined)[] = [];
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #slotById = new Map<string, number>();
  readonly #slotIds: (string | undefined)[] = [];
  readonly #nextContentIds: (string | undefined)[] = [];
  readonly #nextHighlightIds: (string | undefined)[] = [];
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
  #edgeFallback = false;
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
  }

  public query(
    bounds: Bounds,
    retainedBounds: Bounds = bounds,
    allowEdge = true,
    deadline = Infinity,
    now: () => number = () => 0,
  ): VisibilityQueryResult {
    if (this.canReuseCurrent(retainedBounds)) {
      this.#edges.release();
      this.#instrumentation.visibilityHysteresisHits += 1;
      return { changed: false, visibility: this.currentResult() };
    }
    if (this.#edgeFallback) {
      this.#edgeFallback = false;
      return this.queryFull(bounds);
    }
    if (allowEdge && this.canQueryEdges(bounds)) return this.queryEdges(bounds, deadline, now);
    this.#edges.release();
    return this.queryFull(bounds);
  }

  public resortCurrent(): VisibilityResult {
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
    return slot !== undefined && this.#visibleMarkers[slot] === this.#visibleEpoch;
  }

  public invalidateCandidates(): void {
    this.#candidates.invalidate();
  }

  public invalidateForChanges(
    before: Bounds | null | undefined,
    after: Bounds | null | undefined,
  ): void;
  public invalidateForChanges(): void;
  public invalidateForChanges(before?: Bounds | null, after?: Bounds | null): void {
    this.#currentInvalidated = true;
    this.#edges.release();
    this.#candidates.invalidateForChanges(before, after);
  }

  public release(): void {
    this.#candidates.release();
    clearVisibleReferences(this.#contentIds, this.#contentCount);
    clearVisibleReferences(this.#highlightIds, this.#highlightCount);
    clearVisibleReferences(this.#nextContentIds, this.#nextContentCount);
    clearVisibleReferences(this.#nextHighlightIds, this.#nextHighlightCount);
    this.#contentIds.length = 0;
    this.#highlightIds.length = 0;
    this.#nextContentIds.length = 0;
    this.#nextHighlightIds.length = 0;
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
    this.#visibilityEnvelope = undefined;
    this.#hasCurrentVisibility = false;
    this.#currentInvalidated = true;
    this.#edgeFallback = false;
  }

  private beginVisibleQuery(): number | undefined {
    this.#newContentIds.length = 0;
    this.#newHighlightIds.length = 0;
    this.#retainedRanksStable = true;
    clearVisibleReferences(this.#nextContentIds, this.#nextContentCount);
    clearVisibleReferences(this.#nextHighlightIds, this.#nextHighlightCount);
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
    if (changes === "pending")
      return { changed: false, visibility: this.currentResult(), pending: true };
    if (changes === "fallback") {
      this.#edges.release();
      this.#edgeFallback = true;
      return { changed: false, visibility: this.currentResult(), pending: true };
    }
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

  private queryFull(bounds: Bounds): VisibilityQueryResult {
    this.#candidates.refresh(bounds);
    const previousEpoch = this.beginVisibleQuery();
    const membershipUnchanged = this.classifyCandidates(bounds, previousEpoch);
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

  private classifyCandidates(bounds: Bounds, previousEpoch: number | undefined): boolean {
    let unchanged = previousEpoch !== undefined;
    for (let index = 0; index < this.#candidates.count; index += 1) {
      this.#instrumentation.visibilityCandidateVisits += 1;
      const id = this.#candidates.ids[index];
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
    const deltaEligible =
      this.#hasCurrentVisibility &&
      this.#retainedRanksStable &&
      this.#newContentIds.length + this.#newHighlightIds.length <=
        SCENE_PUBLICATION_ROOTS_PER_FRAME;
    if (deltaEligible) this.#enteredIds.push(...this.#newHighlightIds, ...this.#newContentIds);
    const incremental = deltaEligible;
    if (incremental) {
      clearVisibleReferences(this.#nextContentIds, this.#nextContentCount);
      clearVisibleReferences(this.#nextHighlightIds, this.#nextHighlightCount);
      this.#nextContentCount = mergeVisibleBand(
        this.#contentIds,
        this.#contentCount,
        this.#newContentIds,
        this.#nextContentIds,
        (id) => this.containsInBand(id, "content"),
        (left, right) => this.compare(left, right, "content"),
      );
      this.#nextHighlightCount = mergeVisibleBand(
        this.#highlightIds,
        this.#highlightCount,
        this.#newHighlightIds,
        this.#nextHighlightIds,
        (id) => this.containsInBand(id, "highlight"),
        (left, right) => this.compare(left, right, "highlight"),
      );
    }
    this.clearCurrentBand(this.#contentIds, this.#contentCount, "content", deltaEligible);
    this.clearCurrentBand(this.#highlightIds, this.#highlightCount, "highlight", deltaEligible);
    this.#contentCount = copyVisibleReferences(
      this.#nextContentIds,
      this.#nextContentCount,
      this.#contentIds,
    );
    this.#highlightCount = copyVisibleReferences(
      this.#nextHighlightIds,
      this.#nextHighlightCount,
      this.#highlightIds,
    );
    if (!incremental) {
      this.sortBand(this.#highlightIds, this.#highlightCount, "highlight");
      this.sortBand(this.#contentIds, this.#contentCount, "content");
    }
    this.#hasCurrentVisibility = true;
    this.discardNextVisibility();
    return deltaEligible &&
      this.#enteredIds.length + this.#exitedIds.length <= SCENE_PUBLICATION_ROOTS_PER_FRAME
      ? { entered: this.#enteredIds, exited: this.#exitedIds }
      : undefined;
  }

  private clearCurrentBand(
    ids: (string | undefined)[],
    count: number,
    band: RenderBand,
    trackDelta: boolean,
  ): void {
    for (let index = 0; index < count; index += 1) {
      const id = ids[index];
      if (
        trackDelta &&
        id !== undefined &&
        !this.containsInBand(id, band) &&
        this.#enteredIds.length + this.#exitedIds.length <= SCENE_PUBLICATION_ROOTS_PER_FRAME
      )
        this.#exitedIds.push(id);
      ids[index] = undefined;
    }
  }

  private discardNextVisibility(): void {
    clearVisibleReferences(this.#nextContentIds, this.#nextContentCount);
    clearVisibleReferences(this.#nextHighlightIds, this.#nextHighlightCount);
    this.#nextContentCount = 0;
    this.#nextHighlightCount = 0;
    this.#newContentIds.length = 0;
    this.#newHighlightIds.length = 0;
  }

  private canReuseCurrent(retainedBounds: Bounds): boolean {
    return (
      this.#hasCurrentVisibility &&
      !this.#currentInvalidated &&
      this.#visibilityEnvelope !== undefined &&
      containsBounds(this.#visibilityEnvelope, retainedBounds)
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
