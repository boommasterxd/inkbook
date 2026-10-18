import { assertSpatialBounds, type SpatialBounds } from "./bounds";
import type { CellColumns, CellRange, IndexedEntry } from "./index-state";
import { SpatialMap } from "./spatial-map";
import { SpatialSet } from "./spatial-set";

export function createCellRange(
  bounds: SpatialBounds,
  cellSize: number,
  maximumCells: number,
  output?: CellRange,
): CellRange {
  assertSpatialBounds(bounds);
  const minCellX = Math.floor(bounds.minX / cellSize);
  const minCellY = Math.floor(bounds.minY / cellSize);
  const maxCellX = Math.floor(bounds.maxX / cellSize);
  const maxCellY = Math.floor(bounds.maxY / cellSize);
  if (
    !Number.isSafeInteger(minCellX) ||
    !Number.isSafeInteger(minCellY) ||
    !Number.isSafeInteger(maxCellX) ||
    !Number.isSafeInteger(maxCellY)
  ) {
    throw new RangeError("Spatial bounds exceed the supported cell coordinate range.");
  }
  const width = maxCellX - minCellX + 1;
  const height = maxCellY - minCellY + 1;
  const range = output ?? { maxCellX, maxCellY, minCellX, minCellY, overflow: false };
  range.maxCellX = maxCellX;
  range.maxCellY = maxCellY;
  range.minCellX = minCellX;
  range.minCellY = minCellY;
  range.overflow = width > maximumCells || height > Math.floor(maximumCells / width);
  return range;
}

export function cellMembershipCount(range: CellRange): number {
  if (range.overflow) return 0;
  return (range.maxCellX - range.minCellX + 1) * (range.maxCellY - range.minCellY + 1);
}

export function hasSameCellMembership<Id>(current: IndexedEntry<Id>, range: CellRange): boolean {
  if (current.overflow || range.overflow) return current.overflow === range.overflow;
  const keys = current.cellKeys;
  return (
    keys.length === cellMembershipCount(range) * 2 &&
    keys[0] === range.minCellX &&
    keys[1] === range.minCellY &&
    keys[keys.length - 2] === range.maxCellX &&
    keys[keys.length - 1] === range.maxCellY
  );
}

export function createSpatialCellKeys(range: CellRange): number[] {
  const keys: number[] = [];
  for (let cellX = range.minCellX; cellX <= range.maxCellX; cellX += 1) {
    for (let cellY = range.minCellY; cellY <= range.maxCellY; cellY += 1) {
      keys.push(cellX, cellY);
    }
  }
  return keys;
}

/** Copy only changed column and bucket roots so prepared removals remain private. */
export function updateSpatialCells<Id>(
  cells: CellColumns,
  entry: IndexedEntry<Id>,
  add: boolean,
): number {
  let occupiedDelta = 0;
  for (let offset = 0; offset < entry.cellKeys.length; offset += 2) {
    const cellX = entry.cellKeys[offset]!;
    const cellY = entry.cellKeys[offset + 1]!;
    const existingColumn = cells.getForUpdate(cellX, (value) => value.fork());
    const column = existingColumn ?? new SpatialMap<number, SpatialSet<number>>();
    const existingBucket = column.getForUpdate(cellY, (value) => value.fork());
    const bucket = existingBucket ?? new SpatialSet<number>();
    const wasEmpty = bucket.size === 0;
    if (add) bucket.add(entry.slot);
    else bucket.delete(entry.slot);
    occupiedDelta += Number(wasEmpty) - Number(bucket.size === 0);
    if (bucket.size === 0) column.delete(cellY);
    else if (existingBucket === undefined) column.set(cellY, bucket);
    if (column.size === 0) cells.delete(cellX);
    else if (existingColumn === undefined) cells.set(cellX, column);
  }
  return occupiedDelta;
}
