import { boundsIntersect, type SpatialBounds } from "./bounds";
import type {
  CellColumnSource,
  CellRange,
  IndexedEntry,
  SpatialColumnSource,
  SpatialBucketSource,
} from "./index-state";
import { readSpatialSlot, type SpatialSlotSource } from "./slot-storage";
import type { SpatialQueryScratch } from "./query-scratch";
import { shouldVisitAxisRange } from "./cell-traversal-policy";

export function visitSpatialCells<Id>(
  cells: CellColumnSource,
  slots: SpatialSlotSource<IndexedEntry<Id>>,
  range: CellRange,
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  if (shouldVisitAxisRange(range.minCellX, range.maxCellX, cells.size)) {
    visitCellRange(cells, slots, range, bounds, scratch);
  } else {
    visitSparseCells(cells, slots, range, bounds, scratch);
  }
}

export function visitOverflowEntries<Id>(
  overflowSlots: Iterable<number>,
  slots: SpatialSlotSource<IndexedEntry<Id>>,
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  for (const slot of overflowSlots) {
    const entry = readSpatialSlot(slots, slot);
    if (entry !== undefined) scratch.visit(slot, entry.id, boundsIntersect(entry, bounds));
  }
}

export function maximumOverflowBottom<Id>(
  overflowSlots: Iterable<number>,
  slots: SpatialSlotSource<IndexedEntry<Id>>,
): number | undefined {
  let maximum: number | undefined;
  for (const slot of overflowSlots) {
    const entry = readSpatialSlot(slots, slot);
    if (entry !== undefined) maximum = Math.max(maximum ?? -Infinity, entry.maxY);
  }
  return maximum;
}

function visitCellRange<Id>(
  cells: CellColumnSource,
  slots: SpatialSlotSource<IndexedEntry<Id>>,
  range: CellRange,
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  for (let cellX = range.minCellX; cellX <= range.maxCellX; cellX += 1) {
    const column = cells.get(cellX);
    if (column === undefined) continue;
    visitColumn(column, slots, range, bounds, scratch);
  }
}

function visitSparseCells<Id>(
  cells: CellColumnSource,
  slots: SpatialSlotSource<IndexedEntry<Id>>,
  range: CellRange,
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  for (const [cellX, column] of cells) {
    if (cellX < range.minCellX || cellX > range.maxCellX) continue;
    visitColumn(column, slots, range, bounds, scratch);
  }
}

function visitColumn<Id>(
  column: SpatialColumnSource,
  slots: SpatialSlotSource<IndexedEntry<Id>>,
  range: CellRange,
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  if (shouldVisitAxisRange(range.minCellY, range.maxCellY, column.size)) {
    for (let cellY = range.minCellY; cellY <= range.maxCellY; cellY += 1) {
      const bucket = column.get(cellY);
      if (bucket !== undefined) visitBucket(bucket, slots, bounds, scratch);
    }
  } else {
    for (const [cellY, bucket] of column) {
      if (cellY >= range.minCellY && cellY <= range.maxCellY) {
        visitBucket(bucket, slots, bounds, scratch);
      }
    }
  }
}

function visitBucket<Id>(
  bucket: SpatialBucketSource,
  slots: SpatialSlotSource<IndexedEntry<Id>>,
  bounds: SpatialBounds,
  scratch: SpatialQueryScratch<Id>,
): void {
  for (const slot of bucket) {
    const entry = readSpatialSlot(slots, slot);
    if (entry !== undefined) scratch.visit(slot, entry.id, boundsIntersect(entry, bounds));
  }
}
