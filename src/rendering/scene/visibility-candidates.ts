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
  #bounds: Bounds | undefined;
  #key: string | undefined;

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

  public add(id: string): void {
    const slot = this.slotFor(id);
    if (this.#markers[slot] === this.#epoch) return;
    this.#markers[slot] = this.#epoch;
    this.#capacity = growVisibilityCapacity(this.#count + 1, this.#capacity, this.instrumentation);
    this.#ids[this.#count++] = id;
  }

  public refresh(bounds: Bounds): void {
    const range = cellRange(bounds);
    if (range.key === this.#key) {
      this.instrumentation.visibilityCandidateCacheHits += 1;
      return;
    }
    clearVisibleReferences(this.#ids, this.#count);
    this.#count = 0;
    if (this.#epoch === 0xffff_ffff) {
      this.#markers.fill(0);
      this.#epoch = 1;
    } else this.#epoch += 1;
    this.#bounds = range.bounds;
    this.#key = range.key;
    this.instrumentation.spatialQueries += 1;
    this.store.query(range.bounds, this);
  }

  public invalidate(): void {
    this.#bounds = undefined;
    this.#key = undefined;
  }

  public invalidateForChanges(before?: Bounds | null, after?: Bounds | null): void {
    if (
      this.#bounds !== undefined &&
      before !== undefined &&
      after !== undefined &&
      relevantToRange(before, this.#bounds) === relevantToRange(after, this.#bounds)
    )
      return;
    this.invalidate();
  }

  public releaseSlot(slot: number): void {
    this.#markers[slot] = 0;
  }

  public ensureMarkerCapacity(capacity: number): void {
    const markers = new Uint32Array(capacity);
    markers.set(this.#markers);
    this.#markers = markers;
  }

  public release(): void {
    clearVisibleReferences(this.#ids, this.#count);
    this.#ids.length = 0;
    this.#count = 0;
    this.#capacity = 0;
    this.#epoch = 0;
    this.#markers = new Uint32Array(0);
    this.invalidate();
  }
}
