import {
  canonicalPoint,
  normalizeRotation,
  pointDistance,
  roundCanonical,
} from "../geometry/primitives";
import type { PointV1 } from "../schema/types";
import {
  fitClosedShape,
  prepareClosedPath,
  refineClosedShapeSteps,
  type ClosedFit,
} from "./closed-shape-fit";
import { pathLength } from "./linear-recognition";
import type { RecognizedClosedShape } from "./recognition-types";
import { closedContourCorners } from "./closed-contour-corners";
import { hasUnequalParallelogramSides } from "./closed-quadrilateral-evidence";

const KINDS: readonly RecognizedClosedShape["kind"][] = [
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "parallelogram",
  "octagon",
  "star",
];

interface ContourEvidence {
  readonly diagonal: number;
  corners?: readonly PointV1[];
}

interface ClosedSearch {
  readonly points: readonly PointV1[];
  readonly closingGapLimit: number;
  readonly candidates: ClosedFit[];
  readonly evidence: ContourEvidence;
}

export function* recognizeClosedShapeSteps(
  points: readonly PointV1[],
  diagonal: number,
): Generator<void, RecognizedClosedShape | null> {
  const gap = pointDistance(points[0]!, points[points.length - 1]!);
  const closingGapLimit = diagonal * 0.16;
  const drawnLength = pathLength(points);
  // Long open shafts do not merit a closed search; perimeter-like traces may have a side seam.
  if (gap > diagonal / 2 || (gap > closingGapLimit && drawnLength <= diagonal * 2)) return null;
  const contour = drawnLength > diagonal * 2 ? removeClosingTail(points, gap, drawnLength) : points;
  const candidates: ClosedFit[] = [];
  const evidence: ContourEvidence = { diagonal };
  const search: ClosedSearch = { points: contour, closingGapLimit, candidates, evidence };
  const initial = yield* coarseClosedFits(contour, closingGapLimit);
  for (const fit of initial) {
    if (fit === null) continue;
    const best = yield* refineCandidateSteps(search, fit);
    if (isAcceptedFit(best)) candidates.push(best);
  }
  candidates.sort((a, b) => a.score - b.score);
  const resolved = resolveGeometricTie(candidates, contour, evidence);
  const first = candidates[0];
  if (first === undefined || !isAcceptedFit(first)) return null;
  const second = candidates[1];
  if (
    second !== undefined &&
    second.score - first.score < 0.0015 &&
    first.score > 0.01 &&
    first.maxError > 0.026 &&
    !equivalentQuadrilaterals(first, second) &&
    !resolved
  )
    return null;
  return canonicalShape(first.shape);
}

function* refineCandidateSteps(
  search: ClosedSearch,
  initial: ClosedFit,
): Generator<void, ClosedFit> {
  const { points, closingGapLimit } = search;
  const kind = initial.shape.kind;
  const rotation = initial.shape.rotation;
  let best = initial;
  for (let offset = -2; offset <= 2; offset += 0.5) {
    const prepared = prepareClosedPath(points, rotation + offset);
    const fit = prepared === null ? null : fitClosedShape(prepared, kind, closingGapLimit);
    if (fit !== null) best = betterFit(best, fit);
    yield;
  }
  if (supportsContourRefinement(search, kind)) {
    const prepared = prepareClosedPath(points, best.shape.rotation);
    const refined =
      prepared === null ? null : yield* refineClosedShapeSteps(prepared, kind, closingGapLimit);
    if (refined !== null) best = betterFit(best, refined);
    yield;
  }
  return best;
}

function supportsContourRefinement(
  search: ClosedSearch,
  kind: RecognizedClosedShape["kind"],
): boolean {
  if (kind === "parallelogram" || kind === "triangle" || kind === "star") return true;
  if (kind !== "diamond" && kind !== "octagon") return false;
  if (
    search.candidates.some((fit) => fit.shape.kind === "ellipse" || fit.shape.kind === "rectangle")
  )
    return false;
  search.evidence.corners ??= closedContourCorners(search.points, search.evidence.diagonal * 0.05);
  const count = search.evidence.corners.length;
  return kind === "diamond" ? count === 4 : count >= 7 && count <= 8;
}

/** Remove only a short seam excursion that returns much closer to the opposite endpoint. */
function removeClosingTail(
  points: readonly PointV1[],
  gap: number,
  length: number,
): readonly PointV1[] {
  const limit = Math.min(length / 10, gap * 1.5);
  const start = closingTailCut(points, limit, false);
  const end = closingTailCut(points, limit, true);
  if (Math.min(start.distance, end.distance) >= gap / 4) return points;
  return start.distance <= end.distance
    ? points.slice(start.count)
    : points.slice(0, points.length - end.count);
}

function closingTailCut(points: readonly PointV1[], limit: number, reverse: boolean) {
  const endpoint = points[reverse ? 0 : points.length - 1]!;
  let previous = points[reverse ? points.length - 1 : 0]!;
  let best = { count: 0, distance: pointDistance(previous, endpoint) };
  let travelled = 0;
  for (let count = 1; count < points.length - 2; count++) {
    const point = points[reverse ? points.length - 1 - count : count]!;
    travelled += pointDistance(previous, point);
    if (travelled > limit) break;
    const distance = pointDistance(point, endpoint);
    if (distance < best.distance) best = { count, distance };
    previous = point;
  }
  return best;
}

function* coarseClosedFits(
  points: readonly PointV1[],
  closingGapLimit: number,
): Generator<void, (ClosedFit | null)[]> {
  const best: (ClosedFit | null)[] = KINDS.map(() => null);
  for (const angle of candidateAngles(points)) {
    const prepared = prepareClosedPath(points, angle);
    for (const [index, kind] of KINDS.entries()) {
      const fit = prepared === null ? null : fitClosedShape(prepared, kind, closingGapLimit);
      if (fit !== null) best[index] = betterFit(best[index]!, fit);
      yield;
    }
  }
  return best;
}

function betterFit(previous: ClosedFit | null, next: ClosedFit): ClosedFit {
  if (previous === null) return next;
  const accepted = isAcceptedFit(previous);
  if (accepted !== isAcceptedFit(next)) return accepted ? previous : next;
  if (next.score < previous.score - 0.0001) return next;
  if (
    Math.abs(previous.score - next.score) < 0.0001 &&
    axisDistance(next.shape.rotation) < axisDistance(previous.shape.rotation)
  )
    return next;
  return previous;
}

function isAcceptedFit(fit: ClosedFit): boolean {
  return fit.score <= 0.026 && fit.maxError <= 0.065;
}

function axisDistance(rotation: number): number {
  const normalized = ((rotation % 90) + 90) % 90;
  return Math.min(normalized, 90 - normalized);
}

function equivalentQuadrilaterals(first: ClosedFit, second: ClosedFit): boolean {
  const kinds = new Set([first.shape.kind, second.shape.kind]);
  return kinds.has("rectangle") && kinds.has("diamond");
}

function resolveGeometricTie(
  candidates: ClosedFit[],
  points: readonly PointV1[],
  evidence: ContourEvidence,
): boolean {
  const first = candidates[0];
  const second = candidates[1];
  if (first === undefined || second === undefined) return false;
  const close = second.score - first.score < 0.0015;
  let preferred: ClosedFit | undefined;
  const parallelogram = [first, second].find((fit) => fit.shape.kind === "parallelogram");
  const diamond = [first, second].find((fit) => fit.shape.kind === "diamond");
  if (parallelogram !== undefined && diamond !== undefined) {
    evidence.corners ??= closedContourCorners(points, evidence.diagonal * 0.05);
    // Both endpoint positions contribute to uncertainty in a traced side's length.
    const uncertainty = Math.min(parallelogram.score, diamond.score) * evidence.diagonal * 2;
    if (hasUnequalParallelogramSides(points, evidence.corners, uncertainty))
      preferred = parallelogram;
  }
  preferred = curvedPolygonPreference([first, second], points, evidence, close) ?? preferred;
  if (!close && preferred === undefined) return false;
  if (preferred === undefined && first.maxError * 1.5 < second.maxError) return true;
  if (preferred === undefined && second.maxError * 1.5 < first.maxError) preferred = second;
  const rectangle = [first, second].find((fit) => fit.shape.kind === "rectangle");
  if (
    rectangle !== undefined &&
    parallelogram !== undefined &&
    rectangle.maxError < parallelogram.maxError * 0.75
  )
    preferred = rectangle;
  if (preferred === undefined) return false;
  candidates[0] = preferred;
  candidates[1] = preferred === first ? second : first;
  return true;
}

function curvedPolygonPreference(
  pair: readonly ClosedFit[],
  points: readonly PointV1[],
  evidence: ContourEvidence,
  close: boolean,
): ClosedFit | undefined {
  const ellipse = pair.find((fit) => fit.shape.kind === "ellipse");
  const octagon = pair.find((fit) => fit.shape.kind === "octagon");
  if (ellipse === undefined || octagon === undefined) return undefined;
  if (close && smoothEllipseTie(ellipse, octagon, points)) return ellipse;
  const corners = sharpCornerCount(points);
  evidence.corners ??= closedContourCorners(points, evidence.diagonal * 0.05);
  if (
    (corners >= 7 && corners <= 8) ||
    (corners >= 6 && evidence.corners.length >= 7 && evidence.corners.length <= 8)
  )
    return octagon;
  return undefined;
}

function sharpCornerCount(points: readonly PointV1[]): number {
  const positions = [0];
  for (let index = 1; index < points.length; index++)
    positions.push(positions[index - 1]! + pointDistance(points[index - 1]!, points[index]!));
  const minimumSpacing = positions[positions.length - 1]! / 40;
  const corners: PointV1[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const position = positions[index]!;
    while (beforeIndex + 1 < index && positions[beforeIndex + 1]! < position - minimumSpacing / 2)
      beforeIndex++;
    while (afterIndex < points.length - 1 && positions[afterIndex]! < position + minimumSpacing / 2)
      afterIndex++;
    const before = points[beforeIndex]!;
    const point = points[index]!;
    const after = points[afterIndex]!;
    if (turnCosine(before, point, after) > Math.cos(Math.PI / 6)) continue;
    const previous = corners[corners.length - 1];
    if (previous === undefined || pointDistance(previous, point) > minimumSpacing)
      corners.push(point);
  }
  if (
    corners.length > 1 &&
    pointDistance(corners[0]!, corners[corners.length - 1]!) <= minimumSpacing
  )
    corners.pop();
  return corners.length;
}

/** A smooth near-circle needs a clear boundary advantage over the inscribed octagon. */
function smoothEllipseTie(
  first: ClosedFit,
  second: ClosedFit,
  points: readonly PointV1[],
): boolean {
  if (
    first.shape.kind !== "ellipse" ||
    second.shape.kind !== "octagon" ||
    first.maxError * 1.5 >= second.maxError ||
    Math.min(first.shape.width, first.shape.height) <
      Math.max(first.shape.width, first.shape.height) * 0.7
  )
    return false;
  const positions = [0];
  for (let index = 1; index < points.length; index++)
    positions.push(positions[index - 1]! + pointDistance(points[index - 1]!, points[index]!));
  const length = positions[positions.length - 1]!;
  const window = length / 40;
  let beforeIndex = 0;
  let afterIndex = 0;
  // Arc distances keep dense endpoint sampling from exaggerating a short closing hook.
  for (let index = 1; index < points.length - 1; index++) {
    const position = positions[index]!;
    if (position < window * 4 || position > length - window * 4) continue;
    while (positions[beforeIndex + 1]! < position - window) beforeIndex++;
    while (positions[afterIndex]! < position + window) afterIndex++;
    const before = points[beforeIndex]!;
    const point = points[index]!;
    const after = points[afterIndex]!;
    if (turnCosine(before, point, after) < Math.cos(Math.PI / 5)) return false;
  }
  return true;
}

function turnCosine(before: PointV1, point: PointV1, after: PointV1): number {
  const ax = point.x - before.x;
  const ay = point.y - before.y;
  const bx = after.x - point.x;
  const by = after.y - point.y;
  const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return denominator === 0 ? 1 : (ax * bx + ay * by) / denominator;
}

function candidateAngles(points: readonly PointV1[]): number[] {
  const angles = new Set<number>();
  for (let angle = 0; angle < 360; angle += 5) angles.add(angle);
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    if (pointDistance(a, b) < 1e-6) continue;
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    angles.add(Math.round(((angle + 360) % 360) * 2) / 2);
  }
  // Smooth curves need no individual tangent candidates; bounded angular search suffices.
  return angles.size > 120 ? [...angles].slice(0, 72) : [...angles];
}

function canonicalShape(shape: RecognizedClosedShape): RecognizedClosedShape {
  const x = roundCanonical(shape.x);
  const y = roundCanonical(shape.y);
  const width = roundCanonical(shape.width);
  const height = roundCanonical(shape.height);
  return {
    ...shape,
    x,
    y,
    width,
    height,
    rotation: normalizeRotation(shape.rotation),
    pivot: canonicalPoint({ x: x + width / 2, y: y + height / 2 }),
  };
}
