import type { Bounds } from "../../domain/geometry/primitives";
import type { MutableSceneInstrumentation, SceneStorePort, SpatialQuerySink } from "./types";
import { cellRange, relevantToRange } from "./visibility-bounds";
import { clearVisibleReferences } from "./visibility-order";
import { growVisibilityCapacity } from "./visibility-markers";

/** Owns the reusable full-query candidate cache and its deduplication markers. */
export class VisibilityCandidates implements SpatialQuerySink {
  readonly #ids: (string | undefined)[] = [];
  #count = 0;
  #capacity = 0;
  #epoch = 0;
  #markers = new Uint32Array(0);
  #positions = new Uint32Array(0);
  #bounds: Bounds | undefined;
  #key: string | undefined;
  #pendingKey: string | undefined;
  #cursor: ReturnType<NonNullable<SceneStorePort["beginQuery"]>> | undefined;
  #generation = 0;

  public constructor(
    private readonly store: SceneStorePort,
    private readonly instrumentation: MutableSceneInstrumentation,
    private readonly slotFor: (id: string) => number,
  ) {}

  public get ids(): readonly (string | undefined)[] {
    return this.#ids;
  }
  public get count(): number {
    return this.#count;
  }
  public get generation(): number {
    return this.#generation;
  }
  public get complete(): boolean {
    return this.#key !== undefined && this.#pendingKey === undefined;
  }

  public memoryUsage(): number {
    return this.#count * 16 + this.#positions.byteLength + (this.#cursor?.memoryUsage?.() ?? 0);
  }

  public add(id: string): void {
    const slot = this.slotFor(id);
    if (this.#markers[slot] === this.#epoch) return;
    this.#markers[slot] = this.#epoch;
    this.#positions[slot] = this.#count + 1;
    this.#capacity = growVisibilityCapacity(this.#count + 1, this.#capacity, this.instrumentation);
    this.#ids[this.#count++] = id;
  }

  public refresh(bounds: Bounds, deadline = Infinity, now: () => number = () => 0): boolean {
    const range = cellRange(bounds);
    if (range.key === this.#key) {
      this.instrumentation.visibilityCandidateCacheHits += 1;
      return true;
    }
    if (this.#pendingKey !== range.key) this.beginRefresh(range);
    if (this.#cursor === undefined) return true;
    while (now() < deadline) {
      const step = this.#cursor.advance(1);
      if (step.stale) {
        this.invalidate();
        return false;
      }
      for (const id of step.ids) this.add(id);
      if (!step.done) continue;
      this.#cursor = undefined;
      this.#key = range.key;
      this.#pendingKey = undefined;
      return true;
    }
    return false;
  }

  private beginRefresh(range: ReturnType<typeof cellRange>): void {
    this.#generation += 1;
    this.#cursor?.cancel();
    this.#cursor = undefined;
    clearVisibleReferences(this.#ids, this.#count);
    this.#count = 0;
    if (this.#epoch === 0xffff_ffff) {
      this.#markers.fill(0);
      this.#epoch = 1;
    } else this.#epoch += 1;
    this.#bounds = range.bounds;
    this.#key = undefined;
    this.#pendingKey = range.key;
    this.instrumentation.spatialQueries += 1;
    if (this.store.beginQuery !== undefined) this.#cursor = this.store.beginQuery(range.bounds);
    else {
      this.store.query(range.bounds, this);
      this.#key = range.key;
      this.#pendingKey = undefined;
    }
  }

  public invalidate(): void {
    this.#cursor?.cancel();
    this.#cursor = undefined;
    this.#pendingKey = undefined;
    this.#bounds = undefined;
    this.#key = undefined;
  }

  public cancelPending(): void {
    if (this.#pendingKey !== undefined) this.invalidate();
  }

  public invalidateForChanges(before?: Bounds | null, after?: Bounds | null, id?: string): void {
    if (
      this.#pendingKey === undefined &&
      this.#key !== undefined &&
      this.#bounds !== undefined &&
      before !== undefined &&
      after !== undefined
    ) {
      if (relevantToRange(before, this.#bounds) === relevantToRange(after, this.#bounds)) return;
      if (id === undefined) {
        this.invalidate();
        return;
      }
      if (after !== null) {
        const slot = this.slotFor(id);
        this.releaseSlot(slot);
        if (relevantToRange(after, this.#bounds)) this.add(id);
      }
      this.#generation += 1;
      return;
    }
    this.invalidate();
  }

  public releaseSlot(slot: number): void {
    const position = this.#positions[slot] ?? 0;
    if (this.#markers[slot] === this.#epoch && position > 0) {
      const last = this.#ids[--this.#count];
      if (position <= this.#count && last !== undefined) {
        this.#ids[position - 1] = last;
        this.#positions[this.slotFor(last)] = position;
      }
      this.#ids[this.#count] = undefined;
      this.#generation += 1;
    }
    this.#markers[slot] = 0;
    this.#positions[slot] = 0;
  }

  public ensureMarkerCapacity(capacity: number): void {
    const markers = new Uint32Array(capacity);
    markers.set(this.#markers);
    this.#markers = markers;
    const positions = new Uint32Array(capacity);
    positions.set(this.#positions);
    this.#positions = positions;
  }

  public release(): void {
    clearVisibleReferences(this.#ids, this.#count);
    this.#ids.length = 0;
    this.#count = 0;
    this.#capacity = 0;
    this.#epoch = 0;
    this.#markers = new Uint32Array(0);
    this.#positions = new Uint32Array(0);
    this.invalidate();
  }
}
