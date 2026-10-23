import type { Bounds } from "../../../domain/geometry/primitives";

const SPATIAL_CELL_SIZE = 256;

export function sameBounds(left: Bounds | undefined, right: Bounds): boolean {
  return (
    left !== undefined &&
    left.minX === right.minX &&
    left.maxX === right.maxX &&
    left.minY === right.minY &&
    left.maxY === right.maxY
  );
}

export function cellRange(bounds: Bounds): { readonly bounds: Bounds; readonly key: string } {
  const minX = Math.floor(bounds.minX / SPATIAL_CELL_SIZE);
  const minY = Math.floor(bounds.minY / SPATIAL_CELL_SIZE);
  const maxX = Math.floor(bounds.maxX / SPATIAL_CELL_SIZE);
  const maxY = Math.floor(bounds.maxY / SPATIAL_CELL_SIZE);
  return {
    bounds: {
      minX: minX * SPATIAL_CELL_SIZE,
      minY: minY * SPATIAL_CELL_SIZE,
      maxX: (maxX + 1) * SPATIAL_CELL_SIZE,
      maxY: (maxY + 1) * SPATIAL_CELL_SIZE,
    },
    key: `${String(minX)}:${String(minY)}:${String(maxX)}:${String(maxY)}`,
  };
}

export function intersects(left: Bounds, right: Bounds): boolean {
  return (
    left.minX <= right.maxX &&
    left.maxX >= right.minX &&
    left.minY <= right.maxY &&
    left.maxY >= right.minY
  );
}

export function containsBounds(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

export function relevantToRange(bounds: Bounds | null, range: Bounds): boolean {
  return bounds !== null && intersects(bounds, range);
}

export function envelopesOverlap(left: Bounds, right: Bounds): boolean {
  return (
    left.minX < right.maxX &&
    right.minX < left.maxX &&
    left.minY < right.maxY &&
    right.minY < left.maxY
  );
}

/** Return disjoint strips of `source` outside the overlapping target envelope. */
export function envelopeFringes(source: Bounds, target: Bounds): Bounds[] {
  const fringes: Bounds[] = [];
  if (source.minX < target.minX) {
    fringes.push({ ...source, maxX: target.minX });
  }
  if (source.maxX > target.maxX) {
    fringes.push({ ...source, minX: target.maxX });
  }
  const minX = Math.max(source.minX, target.minX);
  const maxX = Math.min(source.maxX, target.maxX);
  if (source.minY < target.minY) {
    fringes.push({ minX, maxX, minY: source.minY, maxY: target.minY });
  }
  if (source.maxY > target.maxY) {
    fringes.push({ minX, maxX, minY: target.maxY, maxY: source.maxY });
  }
  return fringes;
}
