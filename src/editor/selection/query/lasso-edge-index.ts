import { boundsIntersect, type Bounds } from "../../../domain/geometry/public";
import type { PointV1 } from "../../../domain/schema/public";

const BIN_COUNT = 32;
const EPSILON = 1e-9;
const indexCache = new WeakMap<readonly PointV1[], LassoEdgeIndex>();
const ownedPoints = new WeakSet<readonly PointV1[]>();

export function registerImmutableLassoPoints(points: readonly PointV1[]): void {
  ownedPoints.add(points);
}

interface Edge {
  readonly start: PointV1;
  readonly end: PointV1;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

interface LassoEdgeIndex {
  readonly edges: readonly Edge[];
  readonly bins: readonly (readonly number[])[];
  readonly minY: number;
  readonly height: number;
}

function binAt(index: LassoEdgeIndex, y: number): number {
  return Math.max(
    0,
    Math.min(BIN_COUNT - 1, Math.floor(((y - index.minY) / index.height) * BIN_COUNT)),
  );
}

/** A segment tree stores a long edge once, even when it spans every Y bin. */
export function* indexedLassoEdges(
  points: readonly PointV1[],
  bounds: Bounds,
  query: Bounds,
): Generator<number, readonly Edge[]> {
  let index = indexCache.get(points);
  if (index === undefined) {
    index = yield* buildIndex(points, bounds);
    if (ownedPoints.has(points)) indexCache.set(points, index);
  }
  if (points.length <= BIN_COUNT) return yield* querySmallIndex(index, query);
  return yield* queryIndex(index, query);
}

function* querySmallIndex(
  index: LassoEdgeIndex,
  query: Bounds,
): Generator<number, readonly Edge[]> {
  const result: Edge[] = [];
  for (const edge of index.edges) {
    if (edgeOverlaps(edge, query)) result.push(edge);
  }
  if (index.edges.length > 0) yield index.edges.length;
  return result;
}

function* coveringNodes(first: number, last: number): Generator<number> {
  let left = first + BIN_COUNT;
  let right = last + BIN_COUNT;
  while (left <= right) {
    if (left % 2 === 1) yield left++;
    if (right % 2 === 0) yield right--;
    left = Math.floor(left / 2);
    right = Math.floor(right / 2);
  }
}

function* buildIndex(
  points: readonly PointV1[],
  bounds: Bounds,
): Generator<number, LassoEdgeIndex> {
  const edges: Edge[] = [];
  const bins: number[][] = Array.from({ length: BIN_COUNT * 2 }, () => []);
  const index = { edges, bins, minY: bounds.minY, height: Math.max(bounds.maxY - bounds.minY, 1) };
  let insertions = 0;
  for (let edgeIndex = 0; edgeIndex < points.length; edgeIndex += 1) {
    const start = points[edgeIndex]!;
    const end = points[(edgeIndex + 1) % points.length]!;
    const edge = {
      start,
      end,
      minX: Math.min(start.x, end.x),
      maxX: Math.max(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxY: Math.max(start.y, end.y),
    };
    edges.push(edge);
    for (const node of coveringNodes(binAt(index, edge.minY), binAt(index, edge.maxY))) {
      bins[node]!.push(edgeIndex);
      insertions += 1;
      if (insertions % 32 === 0) yield 32;
    }
  }
  if (insertions % 32 !== 0) yield insertions % 32;
  return index;
}

function* queryIndex(index: LassoEdgeIndex, query: Bounds): Generator<number, readonly Edge[]> {
  const seen = new Uint8Array(index.edges.length);
  const result: Edge[] = [];
  let visits = 0;
  const firstBin = binAt(index, query.minY);
  const lastBin = binAt(index, query.maxY);
  const pending: Array<readonly [number, number, number]> = [[1, 0, BIN_COUNT - 1]];
  while (pending.length > 0) {
    const [node, first, last] = pending.pop()!;
    if (last < firstBin || first > lastBin) continue;
    visits += 1;
    if (visits % 32 === 0) yield 32;
    for (const edgeIndex of index.bins[node]!) {
      visits += 1;
      if (visits % 32 === 0) yield 32;
      if (seen[edgeIndex] === 1) continue;
      seen[edgeIndex] = 1;
      const edge = index.edges[edgeIndex]!;
      if (edgeOverlaps(edge, query)) result.push(edge);
    }
    if (first === last) continue;
    const middle = Math.floor((first + last) / 2);
    pending.push([node * 2, first, middle], [node * 2 + 1, middle + 1, last]);
  }
  if (visits % 32 !== 0) yield visits % 32;
  return result;
}

function edgeOverlaps(edge: Edge, query: Bounds): boolean {
  return boundsIntersect(edge, query);
}

export function* indexedPointInPolygon(
  point: PointV1,
  points: readonly PointV1[],
  bounds: Bounds,
  includeBoundary = true,
): Generator<number, boolean> {
  const edges = yield* indexedLassoEdges(points, bounds, {
    minX: point.x - EPSILON,
    maxX: Math.max(point.x, bounds.maxX) + EPSILON,
    minY: point.y - EPSILON,
    maxY: point.y + EPSILON,
  });
  let inside = false;
  let visits = 0;
  for (const { start, end } of edges) {
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    if (
      includeBoundary &&
      Math.abs(cross) <= EPSILON &&
      point.x >= Math.min(start.x, end.x) - EPSILON &&
      point.x <= Math.max(start.x, end.x) + EPSILON &&
      point.y >= Math.min(start.y, end.y) - EPSILON &&
      point.y <= Math.max(start.y, end.y) + EPSILON
    ) {
      yield (visits % 32) + 1;
      return true;
    }
    if (
      start.y > point.y !== end.y > point.y &&
      point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x
    )
      inside = !inside;
    visits += 1;
    if (visits % 32 === 0) yield 32;
  }
  if (visits % 32 !== 0) yield visits % 32;
  return inside;
}
