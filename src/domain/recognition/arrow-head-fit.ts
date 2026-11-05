import {
  includeBoundsPoint,
  pointDistance,
  pointSegmentDistance,
  type Bounds,
} from "../geometry/primitives";
import type { ArrowNodeV1, PointV1 } from "../schema/types";
import { pathLength } from "./linear-recognition";

export interface ArrowHeadFit {
  node: ArrowNodeV1;
  error: number;
  extension: number;
  lateral: number;
  fitOriginalShaft?: true;
  sideAttachment?: true;
}

export interface ArrowHeadPreparation {
  readonly points: readonly PointV1[];
  readonly bounds: Readonly<Bounds>;
}

interface HeadSource {
  readonly points: readonly PointV1[];
  bounds: Readonly<Bounds> | undefined;
  length?: number;
  closure?: { readonly depth: number; readonly closed: boolean };
}

const HEAD_NODES = ["arrow", "triangle", "diamond", "circle"] as const;
const MAX_CONTOUR_ERROR = 0.095;
const CIRCLE_UNITS = Array.from({ length: 33 }, (_, index) => {
  const angle = (index * Math.PI) / 16;
  return { x: Math.cos(angle) - 1, y: Math.sin(angle) };
});

interface HeadContour {
  contour: readonly PointV1[];
  sampled: PointV1[];
  depth: number;
  width: number;
  upper: number;
  lower: number;
  closed: boolean;
  endpoint?: PointV1;
}

export function* fitArrowHeadSteps(
  points: readonly PointV1[],
  zoom: number,
  preparation?: ArrowHeadPreparation,
): Generator<void, ArrowHeadFit | null> {
  const source: HeadSource = {
    points,
    bounds: preparation?.points === points ? preparation.bounds : undefined,
  };
  return (
    (yield* fitAttachmentSteps(source, zoom, false)) ??
    (yield* fitAttachmentSteps(source, zoom, true)) ??
    (yield* fitAttachmentSteps(source, zoom, true, true)) ??
    (yield* fitRetracedArrowSteps(points, zoom))
  );
}

/** A handwritten return to the tip can extend beyond the shaft's first turnaround. */
function* fitRetracedArrowSteps(
  points: readonly PointV1[],
  zoom: number,
): Generator<void, ArrowHeadFit | null> {
  const template = retracedArrowTemplate(points, zoom);
  if (template === null) return null;
  const [upper, tip, lower] = template;
  const normalizer = Math.max(tip.x - Math.min(upper.x, lower.x), upper.y - lower.y);
  yield;
  const sampled = sampleSegments(points);
  let error = matchError(points, sampled, template, normalizer) / normalizer;
  if (error > MAX_CONTOUR_ERROR) {
    const fitted = fitRetracedWings(points, template, normalizer * MAX_CONTOUR_ERROR);
    if (fitted === null) return null;
    yield;
    error = matchError(points, sampled, fitted, normalizer) / normalizer;
  }
  if (error > MAX_CONTOUR_ERROR) return null;
  const lengthRatio = pathLength(points) / pathLength(template);
  if (lengthRatio < 0.78 || lengthRatio > 2.15) return null;
  return { node: "arrow", error, extension: tip.x, lateral: tip.y, fitOriginalShaft: true };
}

function fitRetracedWings(
  points: readonly PointV1[],
  template: readonly [PointV1, PointV1, PointV1],
  tolerance: number,
): [PointV1, PointV1, PointV1] | null {
  const [upper, tip, lower] = template;
  const tipIndex = points.indexOf(tip);
  const upperFirst = points.indexOf(upper) < points.indexOf(lower);
  const first = fitWingRay(
    points.slice(0, tipIndex + 1),
    tip,
    upperFirst ? upper : lower,
    tolerance,
  );
  const last = fitWingRay(points.slice(tipIndex), tip, upperFirst ? lower : upper, tolerance);
  if (first === null || last === null) return null;
  return upperFirst ? [first, tip, last] : [last, tip, first];
}

/** Intersect exact distance constraints rather than fitting RMS and relaxing maximum error. */
function fitWingRay(
  points: readonly PointV1[],
  tip: PointV1,
  endpoint: PointV1,
  tolerance: number,
): PointV1 | null {
  const initial = Math.atan2(endpoint.y - tip.y, endpoint.x - tip.x);
  const initialX = Math.cos(initial);
  const initialY = Math.sin(initial);
  let minimum = -Infinity;
  let maximum = Infinity;
  for (const point of points) {
    const x = point.x - tip.x;
    const y = point.y - tip.y;
    const radius = Math.hypot(x, y);
    if (radius <= tolerance) continue;
    const angle = Math.atan2(y * initialX - x * initialY, x * initialX + y * initialY);
    const allowance = Math.asin(tolerance / radius);
    minimum = Math.max(minimum, angle - allowance);
    maximum = Math.min(maximum, angle + allowance);
    if (minimum > maximum) return null;
  }
  const angle = initial + (minimum + maximum) / 2;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let length = 0;
  for (const point of points)
    length = Math.max(length, (point.x - tip.x) * dx + (point.y - tip.y) * dy);
  return { x: tip.x + length * dx, y: tip.y + length * dy };
}

function retracedArrowTemplate(
  points: readonly PointV1[],
  zoom: number,
): [PointV1, PointV1, PointV1] | null {
  let upperIndex = 0;
  let lowerIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.y > points[upperIndex]!.y) upperIndex = index;
    if (points[index]!.y < points[lowerIndex]!.y) lowerIndex = index;
  }
  const firstWing = Math.min(upperIndex, lowerIndex);
  const lastWing = Math.max(upperIndex, lowerIndex);
  if (firstWing === 0 || lastWing - firstWing < 2) return null;
  let tipIndex = firstWing;
  for (let index = firstWing + 1; index < lastWing; index += 1)
    if (points[index]!.x > points[tipIndex]!.x) tipIndex = index;
  if (tipIndex === firstWing) return null;
  const upper = points[upperIndex]!;
  const lower = points[lowerIndex]!;
  const tip = points[tipIndex]!;
  const up = { x: upper.x - tip.x, y: upper.y - tip.y };
  const down = { x: lower.x - tip.x, y: lower.y - tip.y };
  if (!supportsRetracedWings(up, down, zoom)) return null;
  const depth = Math.max(-up.x, -down.x);
  const scale = Math.max(depth, upper.y - lower.y);
  if (tip.x < 0 || pointDistance(points[0]!, tip) > scale * 0.3) return null;
  if (pointDistance(points[0]!, points[points.length - 1]!) <= Math.max(1.5 / zoom, depth * 0.14))
    return null;
  if (
    pointDistance(points[points.length - 1]!, points[lastWing]!) > Math.max(3 / zoom, scale * 0.15)
  )
    return null;
  return [upper, tip, lower];
}

function supportsRetracedWings(up: PointV1, down: PointV1, zoom: number): boolean {
  const upLength = Math.hypot(up.x, up.y);
  const downLength = Math.hypot(down.x, down.y);
  const depth = Math.max(-up.x, -down.x);
  if (
    depth * zoom < 2.5 ||
    up.y <= depth * 0.15 ||
    down.y >= -depth * 0.15 ||
    Math.min(upLength, downLength) < Math.max(upLength, downLength) * 0.6 ||
    up.x > -upLength * 0.15 ||
    down.x > -downLength * 0.15
  )
    return false;
  const axisX = -up.x / upLength - down.x / downLength;
  const axisY = -up.y / upLength - down.y / downLength;
  const cosine = (up.x * down.x + up.y * down.y) / (upLength * downLength);
  return (
    axisX / Math.hypot(axisX, axisY) >= Math.cos(Math.PI / 6) &&
    cosine >= Math.cos((Math.PI * 2) / 3) &&
    cosine <= Math.cos(Math.PI / 6)
  );
}

function* fitAttachmentSteps(
  source: HeadSource,
  zoom: number,
  edge: boolean,
  side = false,
): Generator<void, ArrowHeadFit | null> {
  const prepared = side ? prepareSideContour(source, zoom) : prepareContour(source, zoom, edge);
  if (prepared === null) return null;
  const { contour, sampled, depth, width, closed } = prepared;
  const normalizer = Math.max(depth, width * 2);
  let best: ArrowHeadFit | null = null;
  for (const node of HEAD_NODES) {
    if (!supportsNode(node, edge, closed, width / depth)) continue;
    const template = headTemplate(node, depth, width);
    yield;
    let error = matchError(contour, sampled, template, normalizer) / normalizer;
    if (error > MAX_CONTOUR_ERROR && node !== "circle") {
      const uneven = unevenHeadTemplate(node, contour, depth);
      if (uneven !== null) {
        yield;
        error = matchError(contour, sampled, uneven, normalizer) / normalizer;
      }
    }
    if (error > MAX_CONTOUR_ERROR) continue;
    source.length ??= pathLength(source.points);
    const lengthRatio = source.length / pathLength(template);
    if (lengthRatio < 0.78 || lengthRatio > 2.15) continue;
    if (best === null || error < best.error)
      best = attachmentFit(node, error, prepared, edge, side);
  }
  return best;
}

function attachmentFit(
  node: ArrowNodeV1,
  error: number,
  contour: HeadContour,
  edge: boolean,
  side: boolean,
): ArrowHeadFit {
  const result: ArrowHeadFit = {
    node,
    error,
    extension: contour.endpoint?.x ?? (edge ? contour.depth : 0),
    lateral:
      contour.endpoint?.y ?? (edge && node === "circle" ? (contour.upper - contour.lower) / 2 : 0),
  };
  if (side) {
    result.fitOriginalShaft = true;
    result.sideAttachment = true;
  }
  return result;
}

function prepareSideContour(source: HeadSource, zoom: number): HeadContour | null {
  const points = source.points;
  const bounds = (source.bounds ??= contourBounds(points));
  const depth = bounds.maxX - bounds.minX;
  const width = (bounds.maxY - bounds.minY) / 2;
  if (depth * zoom < 2.5 || width < depth * 0.2 || width > depth * 1.2) return null;
  // Both axial extremes must straddle the real shaft attachment. Existing tip/rear fits own theirs.
  if (bounds.minX >= -depth * 0.12 || bounds.maxX <= depth * 0.12) return null;
  if (!hasClosedContour(source, depth, zoom)) return null;
  const endpoint = { x: bounds.maxX, y: (bounds.maxY + bounds.minY) / 2 };
  const contour = points.map((point) => ({ x: point.x - endpoint.x, y: point.y - endpoint.y }));
  return {
    contour,
    sampled: sampleSegments(contour),
    depth,
    width,
    upper: width,
    lower: width,
    closed: true,
    endpoint,
  };
}

function prepareContour(source: HeadSource, zoom: number, edge: boolean): HeadContour | null {
  const points = source.points;
  const oriented = edge ? points : alignedTipContour(points);
  const bounds =
    oriented === points ? (source.bounds ??= contourBounds(points)) : contourBounds(oriented);
  const depth = edge ? bounds.maxX : -bounds.minX;
  const upper = bounds.maxY;
  const lower = -bounds.minY;
  const width = (upper + lower) / 2;
  // Normalized contour samples can underestimate a three-pixel head by half a pixel.
  if (depth * zoom < 2.5 || width < depth * 0.2 || width > depth * 1.2) return null;
  if (Math.abs(upper - lower) > width * 0.65) return null;
  if (edge ? bounds.minX < -depth * 0.12 : bounds.maxX > depth * 0.12) return null;
  const closed = hasClosedContour(source, depth, zoom);
  if (edge && !closed) return null;
  const contour = edge ? points.map((point) => ({ x: point.x - depth, y: point.y })) : oriented;
  return { contour, sampled: sampleSegments(contour), depth, width, upper, lower, closed };
}

/** A full loop may finish with a short repeated boundary instead of at its original seam. */
function hasClosedContour(source: HeadSource, depth: number, zoom: number): boolean {
  if (source.closure?.depth === depth) return source.closure.closed;
  const closed = closesContour(source, depth, zoom);
  source.closure = { depth, closed };
  return closed;
}

function closesContour(source: HeadSource, depth: number, zoom: number): boolean {
  const points = source.points;
  const first = points[0]!;
  const tolerance = Math.max(1.5 / zoom, depth * 0.14);
  if (pointDistance(first, points[points.length - 1]!) <= tolerance) return true;
  const length = (source.length ??= pathLength(points));
  const minimumLoop = depth * 2;
  let travelled = 0;
  let seam = -1;
  let nearest = tolerance;
  for (let index = 1; index < points.length - 1; index++) {
    travelled += pointDistance(points[index - 1]!, points[index]!);
    if (travelled < minimumLoop || length - travelled > length / 4) continue;
    const distance = pointDistance(first, points[index]!);
    if (distance <= nearest) {
      seam = index;
      nearest = distance;
    }
  }
  return seam >= 0 && followsContourBoundary(points, seam, tolerance);
}

/** Match repeated boundary progress with one monotone walk, independent of pointer sampling. */
function followsContourBoundary(
  points: readonly PointV1[],
  seam: number,
  tolerance: number,
): boolean {
  const first = points[0]!;
  const origin = points[seam]!;
  let prefix = 1;
  let before = 0;
  let after = pointDistance(first, points[prefix]!);
  let travelled = 0;
  for (let index = seam + 1; index < points.length; index++) {
    const point = points[index]!;
    travelled += pointDistance(points[index - 1]!, point);
    while (after < travelled && prefix < seam) {
      before = after;
      prefix++;
      after += pointDistance(points[prefix - 1]!, points[prefix]!);
    }
    if (after < travelled) return false;
    const start = points[prefix - 1]!;
    const end = points[prefix]!;
    const ratio = after === before ? 0 : (travelled - before) / (after - before);
    const expected = {
      x: start.x - first.x + (end.x - start.x) * ratio,
      y: start.y - first.y + (end.y - start.y) * ratio,
    };
    if (pointDistance({ x: point.x - origin.x, y: point.y - origin.y }, expected) > tolerance)
      return false;
  }
  return true;
}

function contourBounds(points: readonly PointV1[]): Bounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const point of points) includeBoundsPoint(bounds, point);
  return bounds;
}

function supportsNode(
  node: (typeof HEAD_NODES)[number],
  edge: boolean,
  closed: boolean,
  ratio: number,
): boolean {
  if (edge && node === "arrow") return false;
  if (node !== "arrow" && !closed) return false;
  return node !== "circle" || (ratio >= 0.35 && ratio <= 0.65);
}

function alignedTipContour(points: readonly PointV1[]): readonly PointV1[] {
  let upper = points[0]!;
  let lower = points[0]!;
  for (const point of points) {
    if (point.y > upper.y) upper = point;
    if (point.y < lower.y) lower = point;
  }
  const width = (upper.y - lower.y) / 2;
  if (Math.abs(upper.y + lower.y) <= width * 0.65 || upper.x >= 0 || lower.x >= 0) return points;
  if (Math.min(upper.y, -lower.y) < Math.max(upper.y, -lower.y) * 0.35) return points;
  const upperLength = Math.hypot(upper.x, upper.y);
  const lowerLength = Math.hypot(lower.x, lower.y);
  const x = -upper.x / upperLength - lower.x / lowerLength;
  const y = -upper.y / upperLength - lower.y / lowerLength;
  const magnitude = Math.hypot(x, y);
  // Two visible flanks may define a slightly skewed head, within half the native 30-degree wing angle.
  if (magnitude < 1e-8 || x / magnitude < Math.cos(Math.PI / 12)) return points;
  const dx = x / magnitude;
  const dy = y / magnitude;
  return points.map((point) => ({
    x: point.x * dx + point.y * dy,
    y: point.y * dx - point.x * dy,
  }));
}

function unevenHeadTemplate(
  node: "arrow" | "triangle" | "diamond",
  points: readonly PointV1[],
  depth: number,
): PointV1[] | null {
  let upper = points[0]!;
  let lower = points[0]!;
  let back = points[0]!;
  for (const point of points) {
    if (point.y > upper.y) upper = point;
    if (point.y < lower.y) lower = point;
    if (point.x < back.x) back = point;
  }
  if (upper.x > -depth * 0.2 || lower.x > -depth * 0.2) return null;
  if (Math.abs(upper.x - lower.x) > depth * 0.6) return null;
  const tip = { x: 0, y: 0 };
  if (node === "arrow") return [upper, tip, lower];
  if (node === "triangle") return [tip, upper, lower, tip];
  if (pointSegmentDistance(back, upper, lower) < depth * 0.2) return null;
  return [tip, upper, back, lower, tip];
}

function headTemplate(node: (typeof HEAD_NODES)[number], depth: number, width: number): PointV1[] {
  const tip = { x: 0, y: 0 };
  if (node === "arrow") return [{ x: -depth, y: width }, tip, { x: -depth, y: -width }];
  if (node === "triangle") return [tip, { x: -depth, y: width }, { x: -depth, y: -width }, tip];
  if (node === "diamond")
    return [
      tip,
      { x: -depth / 2, y: width },
      { x: -depth, y: 0 },
      { x: -depth / 2, y: -width },
      tip,
    ];
  return CIRCLE_UNITS.map((point) => ({ x: (point.x * depth) / 2, y: point.y * width }));
}

function matchError(
  points: readonly PointV1[],
  sampled: readonly PointV1[],
  template: readonly PointV1[],
  normalizer: number,
): number {
  const forward = directedError(sampled, template, normalizer);
  if (forward / normalizer > MAX_CONTOUR_ERROR) return forward;
  return Math.max(forward, directedError(sampleSegments(template), points, normalizer));
}

function directedError(
  points: readonly PointV1[],
  path: readonly PointV1[],
  normalizer: number,
): number {
  let maximum = 0;
  for (const point of points) {
    let nearest = Infinity;
    for (let index = 1; index < path.length; index += 1)
      nearest = Math.min(nearest, pointSegmentDistance(point, path[index - 1]!, path[index]!));
    maximum = Math.max(maximum, nearest);
    if (maximum / normalizer > MAX_CONTOUR_ERROR) return maximum;
  }
  return maximum;
}

function sampleSegments(path: readonly PointV1[]): PointV1[] {
  const sampled: PointV1[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const start = path[index]!;
    sampled.push(start);
    const end = path[index + 1];
    if (end !== undefined) sampled.push({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
  }
  return sampled;
}
