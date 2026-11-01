import { pointSegmentDistance } from "../../../domain/geometry/primitives";
import { strokeCenterAt, type StrokeCenter } from "../../../domain/geometry/stroke-path";
import { MAX_STROKE_POINTS } from "../../../domain/schema/constants";
import type {
  SourceStrokeCurve,
  SourceStrokeCurvePoint,
  SourceStrokeCurveSegment,
} from "./source-stroke-curve";
import { ObsidianInkImportError } from "./source-values";

// Centerline fitting stays within .12 before native simplification and rounding.
// Pressure strokes add at most .125; constant-width strokes retain their width-based tolerance.
const CURVE_TOLERANCE = 0.04;
const FILTER_TOLERANCE = 0.08;
const PRESSURE_TOLERANCE = 0.001;
interface Span {
  readonly start: SourceStrokeCurvePoint;
  readonly segment: SourceStrokeCurveSegment;
}
interface Samples {
  readonly points: number[];
  readonly centers: StrokeCenter[];
  readonly edges: (number | undefined)[];
}
type Interval = [number, number];

/** Fit the source curve before the native brush applies its fixed center filter. */
export function* sampleSourceStrokeCurveSteps(
  curve: SourceStrokeCurve,
  remainingPointCapacity: number = MAX_STROKE_POINTS,
): Generator<void, number[]> {
  const capacity = Math.min(MAX_STROKE_POINTS, remainingPointCapacity);
  if (!Number.isInteger(capacity) || capacity < 1) exceedCapacity();
  const only = curve.segments.length === 1 ? curve.segments[0] : undefined;
  if (only?.kind === "line") {
    if (capacity < 2) exceedCapacity();
    return [
      curve.start.x,
      curve.start.y,
      curve.start.pressure,
      only.end.x,
      only.end.y,
      only.end.pressure,
    ];
  }
  let spans = yield* flattenCurveSteps(curve, capacity);
  if (spans.length === 0) return [curve.start.x, curve.start.y, curve.start.pressure];
  while (true) {
    const samples = yield* nativeSamplesSteps(spans, capacity);
    const refine = yield* findRefinementsSteps(samples);
    if (refine.size === 0) return samples.points;
    spans = yield* refineSpansSteps(spans, refine, capacity);
  }
}

function* flattenCurveSteps(curve: SourceStrokeCurve, capacity: number): Generator<void, Span[]> {
  const result: Span[] = [];
  let start = curve.start;
  for (const segment of curve.segments) {
    const pending: Span[] = [{ start, segment }];
    while (pending.length > 0) {
      const span = pending.pop()!;
      if (
        span.segment.kind === "quadratic" &&
        (pointSegmentDistance(span.segment.control, span.start, span.segment.end) >
          CURVE_TOLERANCE ||
          Math.abs(
            span.segment.control.pressure - (span.start.pressure + span.segment.end.pressure) / 2,
          ) > PRESSURE_TOLERANCE)
      ) {
        const [left, right] = splitSpan(span);
        if (result.length + pending.length + 3 > capacity) exceedCapacity();
        pending.push(right, left);
      } else result.push(span);
      if (result.length + pending.length + 1 > capacity) exceedCapacity();
      yield;
    }
    start = segment.end;
  }
  return result;
}

function* nativeSamplesSteps(spans: readonly Span[], capacity: number): Generator<void, Samples> {
  let count = spans.length + 1;
  for (let index = 0; index < spans.length - 1; index += 1) {
    if (spans[index]!.segment.sharpEnd === true) count += 2;
    yield;
  }
  if (count > capacity) exceedCapacity();
  const points = new Array<number>(count * 3);
  const edges: (number | undefined)[] = [];
  putSample(points, 0, spans[0]!.start);
  let output = 1;
  for (let index = 0; index < spans.length; index += 1) {
    const { segment } = spans[index]!;
    putSample(points, output++, segment.end);
    edges.push(index);
    if (index < spans.length - 1 && segment.sharpEnd === true) {
      putSample(points, output++, segment.end);
      putSample(points, output++, segment.end);
      edges.push(undefined, undefined);
    }
    yield;
  }
  const centers: StrokeCenter[] = [];
  for (let index = 0; index < count; index += 1) {
    centers.push(strokeCenterAt(points, index, count));
    yield;
  }
  return { points, centers, edges };
}

function* findRefinementsSteps(samples: Samples): Generator<void, Set<number>> {
  const refine = new Set<number>();
  for (let index = 0; index < samples.edges.length; index += 1) {
    const start = sampleAt(samples.points, index);
    const end = sampleAt(samples.points, index + 1);
    const sourceCovered = coveredByNeighbors(start, end, samples.centers, index);
    const nativeCovered = coveredBySampleNeighbors(
      samples.centers[index]!,
      samples.centers[index + 1]!,
      samples.points,
      index,
    );
    if (!sourceCovered || !nativeCovered) {
      for (
        let edge = Math.max(0, index - 2);
        edge <= Math.min(samples.edges.length - 1, index + 2);
        edge += 1
      ) {
        const span = samples.edges[edge];
        if (span !== undefined) refine.add(span);
      }
    }
    yield;
  }
  return refine;
}

function coveredByNeighbors(
  start: SourceStrokeCurvePoint,
  end: SourceStrokeCurvePoint,
  points: readonly SourceStrokeCurvePoint[],
  index: number,
): boolean {
  const intervals: Interval[] = [];
  for (
    let edge = Math.max(0, index - 2);
    edge <= Math.min(points.length - 2, index + 2);
    edge += 1
  ) {
    const interval = capsuleInterval(start, end, points[edge]!, points[edge + 1]!);
    if (interval !== undefined) intervals.push(interval);
  }
  return coversUnitInterval(intervals);
}

function coveredBySampleNeighbors(
  start: SourceStrokeCurvePoint,
  end: SourceStrokeCurvePoint,
  samples: readonly number[],
  index: number,
): boolean {
  const intervals: Interval[] = [];
  for (
    let edge = Math.max(0, index - 2);
    edge <= Math.min(samples.length / 3 - 2, index + 2);
    edge += 1
  ) {
    const interval = capsuleInterval(
      start,
      end,
      sampleAt(samples, edge),
      sampleAt(samples, edge + 1),
    );
    if (interval !== undefined) intervals.push(interval);
  }
  return coversUnitInterval(intervals);
}

/** A segment lies in a polyline's tolerance tube iff its capsule intervals cover it. */
function coversUnitInterval(intervals: Interval[]): boolean {
  intervals.sort((left, right) => left[0] - right[0]);
  let covered = 0;
  for (const [start, end] of intervals) {
    if (start > covered + Number.EPSILON * 16) return false;
    covered = Math.max(covered, end);
    if (covered >= 1) return true;
  }
  return false;
}

function capsuleInterval(
  start: SourceStrokeCurvePoint,
  end: SourceStrokeCurvePoint,
  first: SourceStrokeCurvePoint,
  last: SourceStrokeCurvePoint,
): Interval | undefined {
  const intervals = [circleInterval(start, end, first), circleInterval(start, end, last)];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const squared = dx * dx + dy * dy;
  if (squared > 0) {
    let body: Interval | undefined = [0, 1];
    body = clipInterval(
      body,
      (start.x - first.x) * dx + (start.y - first.y) * dy,
      (end.x - start.x) * dx + (end.y - start.y) * dy,
      0,
      squared,
    );
    const radius = FILTER_TOLERANCE * Math.sqrt(squared);
    body = clipInterval(
      body,
      (start.x - first.x) * dy - (start.y - first.y) * dx,
      (end.x - start.x) * dy - (end.y - start.y) * dx,
      -radius,
      radius,
    );
    intervals.push(body);
  }
  let result: Interval | undefined;
  for (const interval of intervals) {
    if (interval === undefined) continue;
    result =
      result === undefined
        ? interval
        : [Math.min(result[0], interval[0]), Math.max(result[1], interval[1])];
  }
  return result;
}

function circleInterval(
  start: SourceStrokeCurvePoint,
  end: SourceStrokeCurvePoint,
  center: SourceStrokeCurvePoint,
): Interval | undefined {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const x = start.x - center.x;
  const y = start.y - center.y;
  const squared = dx * dx + dy * dy;
  if (squared === 0) return x * x + y * y <= FILTER_TOLERANCE ** 2 ? [0, 1] : undefined;
  const projection = x * dx + y * dy;
  const cross = x * dy - y * dx;
  const remaining = FILTER_TOLERANCE ** 2 - (cross * cross) / squared;
  if (remaining < 0) return undefined;
  const radius = Math.sqrt(remaining / squared);
  const middle = -projection / squared;
  const from = Math.max(0, middle - radius);
  const to = Math.min(1, middle + radius);
  return from <= to ? [from, to] : undefined;
}

function clipInterval(
  interval: Interval | undefined,
  initial: number,
  velocity: number,
  minimum: number,
  maximum: number,
): Interval | undefined {
  if (interval === undefined) return undefined;
  if (velocity === 0) return initial >= minimum && initial <= maximum ? interval : undefined;
  const first = (minimum - initial) / velocity;
  const second = (maximum - initial) / velocity;
  const from = Math.max(interval[0], Math.min(first, second));
  const to = Math.min(interval[1], Math.max(first, second));
  return from <= to ? [from, to] : undefined;
}

function* refineSpansSteps(
  spans: readonly Span[],
  refine: ReadonlySet<number>,
  capacity: number,
): Generator<void, Span[]> {
  const result: Span[] = [];
  for (let index = 0; index < spans.length; index += 1) {
    if (refine.has(index)) result.push(...splitSpan(spans[index]!));
    else result.push(spans[index]!);
    if (result.length + spans.length - index > capacity) exceedCapacity();
    yield;
  }
  return result;
}

function splitSpan({ start, segment }: Span): [Span, Span] {
  if (segment.kind === "line") {
    const middle = midpoint(start, segment.end);
    return [
      { start, segment: { kind: "line", end: middle } },
      { start: middle, segment },
    ];
  }
  const first = midpoint(start, segment.control);
  const second = midpoint(segment.control, segment.end);
  const middle = midpoint(first, second);
  return [
    { start, segment: { kind: "quadratic", control: first, end: middle } },
    { start: middle, segment: { ...segment, control: second } },
  ];
}

function midpoint(
  first: SourceStrokeCurvePoint,
  last: SourceStrokeCurvePoint,
): SourceStrokeCurvePoint {
  return {
    x: (first.x + last.x) / 2,
    y: (first.y + last.y) / 2,
    pressure: (first.pressure + last.pressure) / 2,
  };
}

function sampleAt(points: readonly number[], index: number): SourceStrokeCurvePoint {
  return { x: points[index * 3]!, y: points[index * 3 + 1]!, pressure: points[index * 3 + 2]! };
}

function putSample(points: number[], index: number, point: SourceStrokeCurvePoint): void {
  points[index * 3] = point.x;
  points[index * 3 + 1] = point.y;
  points[index * 3 + 2] = point.pressure;
}

function exceedCapacity(): never {
  throw new ObsidianInkImportError(
    "capacity-exceeded",
    "Fitting imported stroke geometry exceeds Inkbook's point capacity.",
  );
}
