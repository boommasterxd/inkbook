import { pressureChainContour } from "./pressure-chain-contour";
import type { PointV1 } from "../schema/types";
import type { PressureBoundaryArc, PressureCapsule, PressureDisk } from "./pressure-joins";
import {
  intersectPressureBoundaries,
  pressureBoundaryParameter,
  pressureBoundaryPoint,
  type PressureArcAngleCache,
  type PressureBoundarySegment,
} from "./pressure-boundary-intersections";
import { pressureCapsuleContains } from "./pressure-capsule-containment";

export const MAX_PRESSURE_UNION_SHAPES = 64;
// Cap exact-union effort linearly in input size; native capsules preserve identical fill.
export const PRESSURE_UNION_OPERATIONS_PER_SHAPE = 512;

export interface PressureUnionWork {
  intersectionTests: number;
  containmentTests: number;
  boundaryTests: number;
  intervalTests: number;
  peakIntervals: number;
  visibleFragments: number;
}

export interface PressureUnionResult {
  readonly contours: readonly (readonly PressureBoundarySegment[])[];
  readonly usedFallback: boolean;
  readonly work: Readonly<PressureUnionWork>;
}

type Shape = PressureCapsule | PressureDisk;
interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
interface Source {
  readonly shape: Shape;
  readonly boundaries: readonly PressureBoundarySegment[];
  readonly bounds: Bounds;
  readonly boundaryBounds: readonly Bounds[];
}
interface UnionContext {
  readonly work: PressureUnionWork;
  readonly arcAngles: PressureArcAngleCache;
}
interface Interval {
  first: number;
  last: number;
}
interface Edge {
  readonly boundary: PressureBoundarySegment;
  readonly start: number;
  readonly end: number;
  used: boolean;
}
interface Node {
  readonly point: PointV1;
  readonly outgoing: number[];
  incoming: number;
}

const PARAMETER_ERROR = 64 * Number.EPSILON;

/** Exact convex-capsule union in a fixed-capacity window, with a lossless fallback. */
export function* iteratePressureUnion(
  shapes: readonly Shape[],
): Generator<void, PressureUnionResult> {
  if (shapes.length > MAX_PRESSURE_UNION_SHAPES)
    throw new RangeError("Pressure union capacity exceeded");
  const work = {
    intersectionTests: 0,
    containmentTests: 0,
    boundaryTests: 0,
    intervalTests: 0,
    peakIntervals: 0,
    visibleFragments: 0,
  };
  const chain = pressureChainContour(shapes);
  if (chain !== undefined) return { contours: [chain], usedFallback: false, work };
  if (shapes.length === 1 && shapes[0]!.kind === "capsule")
    return { contours: [pressureShapeBoundary(shapes[0]!)], usedFallback: false, work };
  const context: UnionContext = { work, arcAngles: new WeakMap<PressureBoundaryArc, number>() };
  const sources = shapes.map((shape) => {
    const boundaries = pressureShapeBoundary(shape);
    return {
      shape,
      boundaries,
      bounds: shapeBounds(shape),
      boundaryBounds: boundaries.map(boundaryBounds),
    };
  });
  const visible: PressureBoundarySegment[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    for (const boundary of sources[index]!.boundaries) {
      const intervals = yield* clipBoundary(boundary, index, sources, context);
      if (intervals === undefined) return fallback(sources, work);
      for (const interval of intervals) {
        visible.push(boundarySlice(boundary, interval));
        work.visibleFragments += 1;
        if (visible.length > shapes.length * 16) return fallback(sources, work);
      }
    }
  }
  const contours = yield* stitch(visible, endpointTolerance(sources));
  if (contours === undefined) return fallback(sources, work);
  const merged = contours.map(mergeContour);
  const commands = merged.reduce(
    (count, contour) =>
      count +
      2 +
      contour.reduce(
        (total, edge) =>
          total + (edge.kind === "line" ? 1 : Math.ceil(Math.abs(edge.sweep) / (Math.PI / 2))),
        0,
      ),
    0,
  );
  return commands > shapes.length * 16
    ? fallback(sources, work)
    : { contours: merged, usedFallback: false, work };
}

function fallback(sources: readonly Source[], work: PressureUnionWork): PressureUnionResult {
  return { contours: sources.map((source) => source.boundaries), usedFallback: true, work };
}

export function pressureShapeBoundary(shape: Shape): PressureBoundarySegment[] {
  if (shape.kind === "capsule") {
    return [
      shape.left,
      shape.endCap,
      { ...shape.right, start: shape.right.end, end: shape.right.start },
      shape.startCap,
    ];
  }
  const left = { x: shape.center.x - shape.radius, y: shape.center.y };
  const right = { x: shape.center.x + shape.radius, y: shape.center.y };
  return [
    {
      kind: "arc",
      center: shape.center,
      radius: shape.radius,
      start: left,
      end: right,
      sweep: -Math.PI,
    },
    {
      kind: "arc",
      center: shape.center,
      radius: shape.radius,
      start: right,
      end: left,
      sweep: -Math.PI,
    },
  ];
}

function* clipBoundary(
  boundary: PressureBoundarySegment,
  owner: number,
  sources: readonly Source[],
  context: UnionContext,
): Generator<void, Interval[] | undefined> {
  const { work, arcAngles } = context;
  let intervals = [{ first: 0, last: 1 }];
  const extent = boundaryBounds(boundary);
  for (let other = 0; other < sources.length && intervals.length > 0; other += 1) {
    if (other === owner || !overlaps(extent, sources[other]!.bounds)) continue;
    const source = sources[other]!;
    const cuts = [0, 1];
    for (const [index, edge] of source.boundaries.entries()) {
      if (!overlaps(extent, source.boundaryBounds[index]!)) continue;
      work.intersectionTests += 1;
      for (const intersection of intersectPressureBoundaries(boundary, edge, arcAngles))
        cuts.push(intersection.first);
    }
    cuts.sort((a, b) => a - b);
    const next: Interval[] = [];
    for (const interval of intervals) {
      let first = interval.first;
      for (const cut of cuts) {
        if (cut <= first + PARAMETER_ERROR || cut >= interval.last - PARAMETER_ERROR) continue;
        retainInterval(next, boundary, { first, last: cut }, source, other < owner, context);
        first = cut;
      }
      retainInterval(
        next,
        boundary,
        { first, last: interval.last },
        source,
        other < owner,
        context,
      );
      if (operationCount(work) > sources.length * PRESSURE_UNION_OPERATIONS_PER_SHAPE)
        return undefined;
      yield;
    }
    work.peakIntervals = Math.max(work.peakIntervals, next.length);
    intervals = next;
    yield;
  }
  return intervals;
}

function operationCount(work: PressureUnionWork): number {
  return work.intersectionTests + work.containmentTests + work.boundaryTests + work.intervalTests;
}

function retainInterval(
  output: Interval[],
  boundary: PressureBoundarySegment,
  interval: Interval,
  source: Source,
  earlier: boolean,
  context: UnionContext,
): void {
  const { work } = context;
  work.intervalTests += 1;
  if (interval.last - interval.first <= PARAMETER_ERROR) return;
  const point = pressureBoundaryPoint(boundary, (interval.first + interval.last) / 2);
  if (covered(boundary, point, source, earlier, context)) return;
  const previous = output[output.length - 1];
  if (previous !== undefined && Math.abs(previous.last - interval.first) <= PARAMETER_ERROR)
    previous.last = interval.last;
  else output.push(interval);
}

function covered(
  boundary: PressureBoundarySegment,
  point: PointV1,
  source: Source,
  earlier: boolean,
  context: UnionContext,
): boolean {
  const { work, arcAngles } = context;
  for (const [index, edge] of source.boundaries.entries()) {
    if (!containsPoint(source.boundaryBounds[index]!, point)) continue;
    work.boundaryTests += 1;
    if (pressureBoundaryParameter(edge, point, arcAngles) === undefined) continue;
    const incoming = tangent(boundary, point);
    const adjacent = tangent(edge, point);
    if (incoming.x * adjacent.x + incoming.y * adjacent.y < 0) return true;
    return earlier;
  }
  work.containmentTests += 1;
  return contains(source.shape, point);
}

function contains(shape: Shape, point: PointV1): boolean {
  if (shape.kind === "capsule") return pressureCapsuleContains(shape, point, false);
  const distance = Math.hypot(point.x - shape.center.x, point.y - shape.center.y);
  return distance < shape.radius;
}

function mergeContour(contour: readonly PressureBoundarySegment[]): PressureBoundarySegment[] {
  const result: PressureBoundarySegment[] = [];
  for (const segment of contour) {
    const previous = result[result.length - 1];
    const merged = previous === undefined ? undefined : mergeNeighbors(previous, segment);
    if (merged === undefined) result.push(segment);
    else result[result.length - 1] = merged;
  }
  if (result.length < 2) return result;
  const closing = mergeNeighbors(result[result.length - 1]!, result[0]!);
  if (closing !== undefined) {
    result[0] = closing;
    result.pop();
  }
  return result;
}

function mergeNeighbors(
  first: PressureBoundarySegment,
  last: PressureBoundarySegment,
): PressureBoundarySegment | undefined {
  if (first.kind !== "arc" || last.kind !== "arc") return undefined;
  if (
    first.center.x !== last.center.x ||
    first.center.y !== last.center.y ||
    first.radius !== last.radius ||
    Math.sign(first.sweep) !== Math.sign(last.sweep)
  )
    return undefined;
  const sweep = first.sweep + last.sweep;
  return Math.abs(sweep) <= 2 * Math.PI + PARAMETER_ERROR
    ? { ...first, end: last.end, sweep }
    : undefined;
}

function tangent(boundary: PressureBoundarySegment, point: PointV1): PointV1 {
  if (boundary.kind === "line")
    return { x: boundary.end.x - boundary.start.x, y: boundary.end.y - boundary.start.y };
  const sign = Math.sign(boundary.sweep);
  return { x: (boundary.center.y - point.y) * sign, y: (point.x - boundary.center.x) * sign };
}

function boundarySlice(
  boundary: PressureBoundarySegment,
  interval: Interval,
): PressureBoundarySegment {
  const start = pressureBoundaryPoint(boundary, interval.first);
  const end = pressureBoundaryPoint(boundary, interval.last);
  return boundary.kind === "line"
    ? { kind: "line", start, end }
    : { ...boundary, start, end, sweep: boundary.sweep * (interval.last - interval.first) };
}

function* stitch(
  boundaries: readonly PressureBoundarySegment[],
  tolerance: number,
): Generator<void, PressureBoundarySegment[][] | undefined> {
  const nodes: Node[] = [];
  const buckets = new Map<number, Map<number, number[]>>();
  const edges: Edge[] = [];
  for (const [index, boundary] of boundaries.entries()) {
    const start = nodeFor(boundary.start, nodes, buckets, tolerance);
    const end = nodeFor(boundary.end, nodes, buckets, tolerance);
    nodes[start]!.outgoing.push(index);
    nodes[end]!.incoming += 1;
    edges.push({
      boundary: { ...boundary, start: nodes[start]!.point, end: nodes[end]!.point },
      start,
      end,
      used: false,
    });
    yield;
  }
  if (nodes.some((node) => node.incoming !== node.outgoing.length)) return undefined;
  const contours: PressureBoundarySegment[][] = [];
  for (const edge of edges) {
    if (edge.used) continue;
    const contour = yield* traceContour(edge, edges, nodes);
    if (contour === undefined) return undefined;
    contours.push(contour);
    yield;
  }
  return contours;
}

function* traceContour(
  first: Edge,
  edges: Edge[],
  nodes: readonly Node[],
): Generator<void, PressureBoundarySegment[] | undefined> {
  const contour: PressureBoundarySegment[] = [];
  let current = first;
  do {
    if (current.used) return undefined;
    current.used = true;
    contour.push(current.boundary);
    if (current.end === first.start) return contour;
    const next = nodes[current.end]!.outgoing.find((index) => !edges[index]!.used);
    if (next === undefined) return undefined;
    current = edges[next]!;
    yield;
  } while (contour.length <= edges.length);
  return undefined;
}

function nodeFor(
  point: PointV1,
  nodes: Node[],
  buckets: Map<number, Map<number, number[]>>,
  tolerance: number,
): number {
  const x = Math.floor(point.x / tolerance);
  const y = Math.floor(point.y / tolerance);
  for (let dx = -1; dx <= 1; dx += 1) {
    const column = buckets.get(x + dx);
    if (column === undefined) continue;
    for (let dy = -1; dy <= 1; dy += 1) {
      const candidates = column.get(y + dy);
      if (candidates === undefined) continue;
      for (const index of candidates) {
        const candidate = nodes[index]!.point;
        if (Math.hypot(point.x - candidate.x, point.y - candidate.y) <= tolerance) return index;
      }
    }
  }
  const index = nodes.length;
  nodes.push({ point, outgoing: [], incoming: 0 });
  let column = buckets.get(x);
  if (column === undefined) {
    column = new Map();
    buckets.set(x, column);
  }
  const bucket = column.get(y);
  if (bucket === undefined) column.set(y, [index]);
  else bucket.push(index);
  return index;
}

function shapeBounds(shape: Shape): Bounds {
  const first = shape.kind === "dot" ? shape : shape.start;
  const last = shape.kind === "dot" ? shape : shape.end;
  return {
    minX: Math.min(first.center.x - first.radius, last.center.x - last.radius),
    minY: Math.min(first.center.y - first.radius, last.center.y - last.radius),
    maxX: Math.max(first.center.x + first.radius, last.center.x + last.radius),
    maxY: Math.max(first.center.y + first.radius, last.center.y + last.radius),
  };
}

function overlaps(first: Bounds, second: Bounds): boolean {
  return (
    first.minX <= second.maxX &&
    first.maxX >= second.minX &&
    first.minY <= second.maxY &&
    first.maxY >= second.minY
  );
}

function endpointTolerance(sources: readonly Source[]): number {
  let magnitude = 1;
  for (const { bounds } of sources)
    magnitude = Math.max(
      magnitude,
      Math.abs(bounds.minX),
      Math.abs(bounds.minY),
      Math.abs(bounds.maxX),
      Math.abs(bounds.maxY),
    );
  return Math.max(1e-10, 128 * Number.EPSILON * magnitude);
}

function boundaryBounds(boundary: PressureBoundarySegment): Bounds {
  const bounds =
    boundary.kind === "line"
      ? {
          minX: Math.min(boundary.start.x, boundary.end.x),
          minY: Math.min(boundary.start.y, boundary.end.y),
          maxX: Math.max(boundary.start.x, boundary.end.x),
          maxY: Math.max(boundary.start.y, boundary.end.y),
        }
      : {
          minX: boundary.center.x - boundary.radius,
          minY: boundary.center.y - boundary.radius,
          maxX: boundary.center.x + boundary.radius,
          maxY: boundary.center.y + boundary.radius,
        };
  const pad =
    128 *
    Number.EPSILON *
    Math.max(
      1,
      Math.abs(bounds.minX),
      Math.abs(bounds.minY),
      Math.abs(bounds.maxX),
      Math.abs(bounds.maxY),
    );
  return {
    minX: bounds.minX - pad,
    minY: bounds.minY - pad,
    maxX: bounds.maxX + pad,
    maxY: bounds.maxY + pad,
  };
}
function containsPoint(bounds: Bounds, point: PointV1): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}
