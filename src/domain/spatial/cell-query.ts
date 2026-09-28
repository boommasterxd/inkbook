import { boundsIntersect, type SpatialBounds } from "./bounds";
import type { CellColumns, CellRange, IndexedEntry } from "./index-state";
import type { SpatialQueryScratch } from "./query-scratch";

export function visitSpatialCells<Id>(
  cells: CellColumns,
  slots: readonly (IndexedEntry<Id> | undefined)[],
  occupiedCellCount: number,
  range: CellRange,
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  if (shouldVisitRange(range, occupiedCellCount)) {
    visitCellRange(cells, slots, range, bounds, scratch);
  } else {
    visitSparseCells(cells, slots, range, bounds, scratch);
  }
}

export function visitOverflowEntries<Id>(
  overflowSlots: ReadonlySet<number>,
  slots: readonly (IndexedEntry<Id> | undefined)[],
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  for (const slot of overflowSlots) {
    const entry = slots[slot];
    if (entry !== undefined) scratch.visit(slot, entry.id, boundsIntersect(entry, bounds));
  }
}

export function maximumOverflowBottom<Id>(
  overflowSlots: ReadonlySet<number>,
  slots: readonly (IndexedEntry<Id> | undefined)[],
): number | undefined {
  let maximum: number | undefined;
  for (const slot of overflowSlots) {
    const entry = slots[slot];
    if (entry !== undefined) maximum = Math.max(maximum ?? -Infinity, entry.maxY);
  }
  return maximum;
}

function shouldVisitRange(range: CellRange, occupiedCellCount: number): boolean {
  const width = range.maxCellX - range.minCellX + 1;
  const height = range.maxCellY - range.minCellY + 1;
  return width <= occupiedCellCount && height <= Math.floor(occupiedCellCount / width);
}

function visitCellRange<Id>(
  cells: CellColumns,
  slots: readonly (IndexedEntry<Id> | undefined)[],
  range: CellRange,
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  for (let cellX = range.minCellX; cellX <= range.maxCellX; cellX += 1) {
    const column = cells.get(cellX);
    if (column === undefined) continue;
    for (let cellY = range.minCellY; cellY <= range.maxCellY; cellY += 1) {
      const bucket = column.get(cellY);
      if (bucket !== undefined) visitBucket(bucket, slots, bounds, scratch);
    }
  }
}

function visitSparseCells<Id>(
  cells: CellColumns,
  slots: readonly (IndexedEntry<Id> | undefined)[],
  range: CellRange,
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  for (const [cellX, column] of cells) {
    if (cellX < range.minCellX || cellX > range.maxCellX) continue;
    for (const [cellY, bucket] of column) {
      if (cellY >= range.minCellY && cellY <= range.maxCellY) {
        visitBucket(bucket, slots, bounds, scratch);
      }
    }
  }
}

function visitBucket<Id>(
  bucket: ReadonlySet<number>,
  slots: readonly (IndexedEntry<Id> | undefined)[],
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  for (const slot of bucket) {
    const entry = slots[slot];
    if (entry !== undefined) scratch.visit(slot, entry.id, boundsIntersect(entry, bounds));
  }
}
