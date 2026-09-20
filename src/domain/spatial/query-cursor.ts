import { boundsIntersect, type SpatialBounds } from "./bounds";
import type { CellColumns, CellRange, IndexedEntry } from "./index-state";

interface QuerySource<Id> {
  readonly cells: CellColumns;
  readonly slots: readonly (IndexedEntry<Id> | undefined)[];
  readonly overflowSlots: ReadonlySet<number>;
  readonly occupiedCellCount: number;
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
  const width = range.maxCellX - range.minCellX + 1;
  const height = range.maxCellY - range.minCellY + 1;
  if (width <= source.occupiedCellCount && height <= Math.floor(source.occupiedCellCount / width))
    yield* visitRange(source.cells, range);
  else yield* visitOccupied(source.cells, range);
  // Charge the transition from grid to overflow even for an empty grid.
  yield undefined;
  yield* source.overflowSlots;
}

function* visitRange(cells: CellColumns, range: CellRange): Generator<number | undefined, void> {
  for (let x = range.minCellX; x <= range.maxCellX; x += 1) {
    const column = cells.get(x);
    yield undefined;
    if (column === undefined) continue;
    for (let y = range.minCellY; y <= range.maxCellY; y += 1) {
      const bucket = column.get(y);
      yield undefined;
      if (bucket !== undefined) yield* bucket;
      yield undefined;
    }
    yield undefined;
  }
}

function* visitOccupied(cells: CellColumns, range: CellRange): Generator<number | undefined, void> {
  for (const [x, column] of cells) {
    yield undefined;
    if (x < range.minCellX || x > range.maxCellX) continue;
    for (const [y, bucket] of column) {
      yield undefined;
      if (y >= range.minCellY && y <= range.maxCellY) yield* bucket;
      yield undefined;
    }
    yield undefined;
  }
}
