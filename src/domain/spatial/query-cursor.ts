import { boundsIntersect, type SpatialBounds } from "./bounds";
import type { CellColumns, CellRange, IndexedEntry } from "./index-state";
import { shouldVisitAxisRange } from "./cell-traversal-policy";

interface QuerySource<Id> {
  readonly cells: CellColumns;
  readonly slots: readonly (IndexedEntry<Id> | undefined)[];
  readonly overflowSlots: ReadonlySet<number>;
  readonly generation: () => number;
}

export interface SpatialQueryStep<Id> {
  readonly ids: readonly Id[];
  readonly workUnits: number;
  readonly done: boolean;
  readonly stale: boolean;
}

/** Each iterator advance visits at most one column, cell, or candidate slot. */
export class SpatialQueryCursor<Id> {
  private source: QuerySource<Id> | undefined;
  private iterator: Generator<number | undefined, void> | undefined;
  private seen: Set<number> | undefined = new Set();
  private readonly generation: number;
  private stale = false;
  private readonly bounds: SpatialBounds;

  public constructor(source: QuerySource<Id>, range: CellRange, bounds: SpatialBounds) {
    this.source = source;
    this.generation = source.generation();
    this.bounds = { ...bounds };
    this.iterator = visitSlots(source, range);
  }

  public advance(maxWorkUnits: number): SpatialQueryStep<Id> {
    if (!Number.isSafeInteger(maxWorkUnits) || maxWorkUnits < 1)
      throw new RangeError("Spatial query work budget must be a positive safe integer.");
    if (this.source !== undefined && this.source.generation() !== this.generation) {
      this.stale = true;
      this.cancel();
    }
    const ids: Id[] = [];
    let workUnits = 0;
    while (this.iterator !== undefined && workUnits < maxWorkUnits) {
      const next = this.iterator.next();
      workUnits += 1;
      if (next.done) this.cancel();
      else if (next.value !== undefined) this.visitCandidate(next.value, ids);
    }
    return { ids, workUnits, done: this.iterator === undefined, stale: this.stale };
  }

  public cancel(): void {
    this.iterator?.return();
    this.iterator = undefined;
    this.source = undefined;
    this.seen = undefined;
  }

  /** Conservative iterator/slot bookkeeping; engine-specific Set overhead may differ. */
  public memoryUsage(): number {
    return this.iterator === undefined ? 0 : 512 + (this.seen?.size ?? 0) * 32;
  }

  private visitCandidate(slot: number, ids: Id[]): void {
    if (this.seen!.has(slot)) return;
    this.seen!.add(slot);
    const entry = this.source!.slots[slot];
    if (entry !== undefined && boundsIntersect(entry, this.bounds)) ids.push(entry.id);
  }
}

function* visitSlots<Id>(
  source: QuerySource<Id>,
  range: CellRange,
): Generator<number | undefined, void> {
  yield* visitGrid(source.cells, range);
  // Charge the transition from grid to overflow even for an empty grid.
  yield undefined;
  yield* source.overflowSlots;
}

function* visitGrid(cells: CellColumns, range: CellRange): Generator<number | undefined, void> {
  const columns = new QueryAxis<Map<number, Set<number>>>();
  const rows = new QueryAxis<Set<number>>();
  columns.reset(cells, range.minCellX, range.maxCellX);
  while (columns.next()) {
    yield undefined;
    const column = columns.value;
    if (column === undefined || columns.key < range.minCellX || columns.key > range.maxCellX)
      continue;
    rows.reset(column, range.minCellY, range.maxCellY);
    while (rows.next()) {
      yield undefined;
      if (rows.value !== undefined && rows.key >= range.minCellY && rows.key <= range.maxCellY)
        yield* rows.value;
      yield undefined;
    }
    yield undefined;
  }
}

/** Two reusable axis states avoid allocating a generator or coordinate tuple per column. */
class QueryAxis<Value> {
  #coordinate = 0;
  #maximum = 0;
  #entries: MapIterator<[number, Value]> | undefined;
  #map: ReadonlyMap<number, Value> | undefined;
  public key = 0;
  public value: Value | undefined;

  public reset(map: ReadonlyMap<number, Value>, minimum: number, maximum: number): void {
    this.#map = map;
    this.#coordinate = minimum;
    this.#maximum = maximum;
    this.#entries = shouldVisitAxisRange(minimum, maximum, map.size) ? undefined : map.entries();
  }

  public next(): boolean {
    if (this.#entries !== undefined) {
      const next = this.#entries.next();
      if (next.done) return false;
      [this.key, this.value] = next.value;
    } else {
      if (this.#coordinate > this.#maximum) return false;
      this.key = this.#coordinate++;
      this.value = this.#map!.get(this.key);
    }
    return true;
  }
}
