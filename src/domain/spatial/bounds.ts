export interface SpatialBounds {
  readonly maxX: number;
  readonly maxY: number;
  readonly minX: number;
  readonly minY: number;
}

export function assertSpatialBounds(bounds: SpatialBounds): void {
  const { maxX, maxY, minX, minY } = bounds;

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    throw new TypeError("Spatial bounds coordinates must be finite.");
  }

  if (minX > maxX || minY > maxY) {
    throw new RangeError("Spatial bounds minima must not exceed their maxima.");
  }
}

export function boundsIntersect(left: SpatialBounds, right: SpatialBounds): boolean {
  return (
    left.minX <= right.maxX &&
    left.maxX >= right.minX &&
    left.minY <= right.maxY &&
    left.maxY >= right.minY
  );
}
