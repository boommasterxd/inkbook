import type { Bounds } from "../../../domain/geometry/primitives";
import type { SceneCamera, SceneViewport } from "../types";

const SPATIAL_CELL_SIZE = 256;

/** Exact clipping edges and the position-independent inputs that determine their extent. */
export class ProjectedViewportBounds implements Bounds {
  public readonly minX: number;
  public readonly maxX: number;
  public readonly minY: number;
  public readonly maxY: number;
  readonly #width: number;
  readonly #height: number;
  readonly #zoom: number;
  readonly #horizontalMargin: number;
  readonly #verticalMargin: number;

  public constructor(
    viewport: SceneViewport,
    camera: SceneCamera,
    horizontalMargin: number,
    verticalMargin = horizontalMargin,
  ) {
    this.#width = viewport.width;
    this.#height = viewport.height;
    this.#zoom = camera.zoom;
    this.#horizontalMargin = horizontalMargin;
    this.#verticalMargin = verticalMargin;
    const overscan = horizontalMargin / camera.zoom;
    const verticalOverscan = verticalMargin / camera.zoom;
    this.minX = viewport.left / camera.zoom - camera.x - overscan;
    this.maxX = (viewport.left + viewport.width) / camera.zoom - camera.x + overscan;
    this.minY = viewport.top / camera.zoom - verticalOverscan;
    this.maxY = (viewport.top + viewport.height) / camera.zoom + verticalOverscan;
  }

  public static sameExtent(left: Bounds, right: Bounds): boolean {
    if (left instanceof ProjectedViewportBounds && right instanceof ProjectedViewportBounds)
      return (
        left.#width === right.#width &&
        left.#height === right.#height &&
        left.#zoom === right.#zoom &&
        left.#horizontalMargin === right.#horizontalMargin &&
        left.#verticalMargin === right.#verticalMargin
      );
    return (
      left.maxX - left.minX === right.maxX - right.minX &&
      left.maxY - left.minY === right.maxY - right.minY
    );
  }
}

export function sameBounds(left: Bounds | undefined, right: Bounds | undefined): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.minX === right.minX &&
      left.maxX === right.maxX &&
      left.minY === right.minY &&
      left.maxY === right.maxY)
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

/** Cell coverage ends at the next cell's origin; the index accepts inclusive coordinates. */
export function inclusiveCellQuery(bounds: Bounds): Bounds {
  const bits = new DataView(new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT));
  const predecessor = (edge: number): number => {
    if (edge === 0) return -Number.MIN_VALUE;
    bits.setFloat64(0, edge);
    bits.setBigUint64(0, bits.getBigUint64(0) + (edge > 0 ? -1n : 1n));
    return bits.getFloat64(0);
  };
  return { ...bounds, maxX: predecessor(bounds.maxX), maxY: predecessor(bounds.maxY) };
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
