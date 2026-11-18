import type { PointV1 } from "../../../domain/schema/public";
import type { Bounds } from "../../../domain/geometry/public";
import { ownsLassoPoints } from "./lasso-edge-index";

const BLOCK_SIZE = 16;

interface BoundaryRange extends Bounds {
  readonly rising: boolean;
  readonly falling: boolean;
}

const cache = new WeakMap<readonly PointV1[], readonly BoundaryRange[]>();

function* buildRanges(points: readonly PointV1[]): Generator<number, readonly BoundaryRange[]> {
  const ranges: BoundaryRange[] = [];
  for (let first = 0; first < points.length; first += BLOCK_SIZE) {
    let { x: minX, y: minY } = points[first]!;
    let maxX = minX;
    let maxY = minY;
    let rising = true;
    let falling = true;
    const limit = Math.min(first + BLOCK_SIZE, points.length);
    for (let index = first; index < limit; index += 1) {
      const start = points[index]!;
      const end = points[(index + 1) % points.length]!;
      minX = Math.min(minX, end.x);
      minY = Math.min(minY, end.y);
      maxX = Math.max(maxX, end.x);
      maxY = Math.max(maxY, end.y);
      if (end.x === start.x || end.y === start.y) continue;
      const increasesX = end.x > start.x;
      if (increasesX === end.y > start.y) falling = false;
      else rising = false;
    }
    ranges.push({ minX, minY, maxX, maxY, rising, falling });
    yield limit - first;
  }
  return ranges;
}

/** Process small or unowned inputs directly. Only complete immutable indexes are reusable. */
export function* visitBoundaryCandidates(
  points: readonly PointV1[],
  mayContain: (range: BoundaryRange) => boolean,
  visit: (index: number) => void,
): Generator<number, void> {
  let ranges = cache.get(points);
  if (ranges === undefined && points.length > 32 && ownsLassoPoints(points)) {
    ranges = yield* buildRanges(points);
    cache.set(points, ranges);
  }
  let work = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (ranges !== undefined && index % BLOCK_SIZE === 0) {
      const mayVisit = mayContain(ranges[index / BLOCK_SIZE]!);
      if (++work % 32 === 0) yield 32;
      if (!mayVisit) {
        index += BLOCK_SIZE - 1;
        continue;
      }
    }
    visit(index);
    if (++work % 32 === 0) yield 32;
  }
  if (ranges !== undefined && work % 32 !== 0) yield work % 32;
}

/** If both coordinates are before the start or past the end, 0 < projection < 1 is impossible. */
export function mayProjectVertex(range: Bounds, start: PointV1, end: PointV1): boolean {
  return !beforeEndpoint(range, start, end) && !beforeEndpoint(range, end, start);
}

function beforeEndpoint(range: Bounds, start: PointV1, end: PointV1): boolean {
  const beforeX =
    end.x === start.x || (end.x > start.x ? range.maxX <= start.x : range.minX >= start.x);
  const beforeY =
    end.y === start.y || (end.y > start.y ? range.maxY <= start.y : range.minY >= start.y);
  return beforeX && beforeY;
}

/** For edges in a common slope quadrant the opposite exterior corners cannot project inside. */
export function mayCoverPoint(range: BoundaryRange, point: PointV1): boolean {
  const left = range.minX === range.maxX || point.x <= range.minX;
  const right = range.minX === range.maxX || point.x >= range.maxX;
  const above = range.minY === range.maxY || point.y <= range.minY;
  const below = range.minY === range.maxY || point.y >= range.maxY;
  if (range.rising && ((left && above) || (right && below))) return false;
  return !(range.falling && ((left && below) || (right && above)));
}
