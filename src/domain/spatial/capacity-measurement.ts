import { assertSpatialBounds, type SpatialBounds } from "./bounds";
import { MAX_ELEMENT_CELLS, SPATIAL_CELL_SIZE } from "./uniform-spatial-index";

import type { SpatialCapacityMeasurement } from "./capacity";

export function measureSpatialCapacity(
  boundsValues: Iterable<SpatialBounds>,
): SpatialCapacityMeasurement {
  let cellMemberships = 0;
  let overflowElements = 0;
  for (const bounds of boundsValues) {
    const memberships = spatialCellMembershipCount(bounds);
    if (memberships > MAX_ELEMENT_CELLS) overflowElements += 1;
    else cellMemberships += memberships;
  }
  return Object.freeze({ cellMemberships, overflowElements });
}

export function spatialCellMembershipCount(bounds: SpatialBounds): number {
  assertSpatialBounds(bounds);
  const columns = cellSpan(bounds.minX, bounds.maxX);
  const rows = cellSpan(bounds.minY, bounds.maxY);
  if (columns > MAX_ELEMENT_CELLS || rows > Math.floor(MAX_ELEMENT_CELLS / columns)) {
    return MAX_ELEMENT_CELLS + 1;
  }
  return columns * rows;
}

function cellSpan(minimum: number, maximum: number): number {
  const first = Math.floor(minimum / SPATIAL_CELL_SIZE);
  const last = Math.floor(maximum / SPATIAL_CELL_SIZE);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) {
    throw new RangeError("Spatial bounds exceed the supported cell coordinate range.");
  }
  return last - first + 1;
}
