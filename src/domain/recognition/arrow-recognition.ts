import type { ArrowNodeV1, PointV1 } from "../schema/types";
import type { RecognizedLinear } from "./recognition-types";
import {
  canonicalPoint,
  includeBoundsPoint,
  linearPivot,
  pointDistance,
} from "../geometry/primitives";
import { fitArrowHeadSteps, type ArrowHeadFit, type ArrowHeadPreparation } from "./arrow-head-fit";

const TANGENT_RANGES = [10, 25, 50, 100] as const;

interface HeadRank {
  error: number;
  sideAttachment?: true;
}

interface Head extends HeadRank {
  cut: number;
  node: ArrowNodeV1;
  endpoint?: PointV1;
  fitOriginalShaft?: true;
}

/** Recognizes endpoint motifs without bypassing the conservative shaft fitter. */
export function* recognizeArrowSteps(
  points: readonly PointV1[],
  fitLinear: (points: readonly PointV1[]) => RecognizedLinear | null,
  zoom = 1,
): Generator<void, RecognizedLinear | null> {
  if (points.length < 5) return null;
  const starts = yield* heads([...points].reverse(), zoom);
  const ends = yield* heads(points, zoom);
  const absent: Head = { cut: points.length - 1, node: "none", error: 0 };
  let best: { result: RecognizedLinear; error: number; heads: number; sides: number } | null = null;
  for (const start of [absent, ...starts]) {
    for (const end of [absent, ...ends]) {
      if (start.node === "none" && end.node === "none") continue;
      const headCount = Number(start.node !== "none") + Number(end.node !== "none");
      if (best !== null && headCount < best.heads) continue;
      const shaft = shaftPoints(points, start, end);
      if (shaft === null) continue;
      yield;
      const result = fitLinear(shaft);
      if (result === null) continue;
      const error = start.error + end.error;
      const sides = Number(Boolean(start.sideAttachment)) + Number(Boolean(end.sideAttachment));
      if (
        best !== null &&
        headCount === best.heads &&
        (sides > best.sides || (sides === best.sides && error >= best.error))
      )
        continue;
      best = {
        error,
        heads: headCount,
        sides,
        result: arrowResult(result, start, end),
      };
    }
  }
  return best?.result ?? null;
}

function shaftPoints(points: readonly PointV1[], start: Head, end: Head): PointV1[] | null {
  const from = points.length - 1 - start.cut;
  if (end.cut - from < 2) return null;
  const shaft = points.slice(from, end.cut + 1);
  if (start.endpoint !== undefined && !start.fitOriginalShaft) shaft[0] = start.endpoint;
  if (end.endpoint !== undefined && !end.fitOriginalShaft) shaft[shaft.length - 1] = end.endpoint;
  return shaft;
}

function arrowResult(result: RecognizedLinear, startHead: Head, endHead: Head): RecognizedLinear {
  const start = canonicalPoint(startHead.endpoint ?? result.start);
  const end = canonicalPoint(endHead.endpoint ?? result.end);
  return {
    ...result,
    kind: "arrow",
    start,
    end,
    startNode: startHead.node,
    endNode: endHead.node,
    pivot: linearPivot(start, end, result.bend),
  };
}

function* heads(points: readonly PointV1[], zoom: number): Generator<void, Head[]> {
  const candidates: Head[] = [];
  for (let cut = 2; cut < points.length - 2; cut += 1) {
    const anchor = points[cut];
    if (anchor === undefined) continue;
    let best: Head | null = null;
    for (const range of TANGENT_RANGES) {
      yield;
      const axis = shaftTangent(points, cut, zoom, range);
      if (axis === null) continue;
      const local = projectHeadContour(points, cut, axis);
      const head = yield* fitArrowHeadSteps(local.points, zoom, local);
      if (head === null) continue;
      if (best === null || compareHeads(head, best) < 0)
        best = preparedHead(cut, head, anchor, axis);
      if (best.error < 0.05 && !best.sideAttachment) break;
    }
    if (best !== null) candidates.push(best);
  }
  const earliest = candidates[0];
  const ranked = candidates.sort(compareHeads).slice(0, 6);
  // A repeated contour can score better after the real shaft has already entered the head.
  // Reserve one slot for the earliest complete motif; the shaft fitter still validates it.
  if (earliest !== undefined && !ranked.includes(earliest)) ranked[ranked.length - 1] = earliest;
  return ranked;
}

/** Prefer constrained native attachments before freely translated side-boundary fallbacks. */
function compareHeads(a: HeadRank, b: HeadRank): number {
  return Number(Boolean(a.sideAttachment)) - Number(Boolean(b.sideAttachment)) || a.error - b.error;
}

function preparedHead(cut: number, fit: ArrowHeadFit, anchor: PointV1, axis: PointV1): Head {
  const head: Head = { cut, node: fit.node, error: fit.error };
  if (fit.fitOriginalShaft) head.fitOriginalShaft = true;
  if (fit.sideAttachment) head.sideAttachment = true;
  if (fit.extension !== 0 || fit.lateral !== 0)
    head.endpoint = {
      x: anchor.x + axis.x * fit.extension - axis.y * fit.lateral,
      y: anchor.y + axis.y * fit.extension + axis.x * fit.lateral,
    };
  return head;
}

/** Regress the local shaft direction instead of magnifying subpixel segment jitter. */
function shaftTangent(
  points: readonly PointV1[],
  cut: number,
  zoom: number,
  range: number,
): PointV1 | null {
  const anchor = points[cut]!;
  let length = 0;
  let count = 1;
  let time = 0;
  let timeSquare = 0;
  let x = anchor.x;
  let y = anchor.y;
  let timeX = 0;
  let timeY = 0;
  for (let index = cut - 1; index >= 0 && length * zoom < range; index -= 1) {
    const point = points[index]!;
    length += pointDistance(point, points[index + 1]!);
    count += 1;
    time -= length;
    timeSquare += length ** 2;
    x += point.x;
    y += point.y;
    timeX -= length * point.x;
    timeY -= length * point.y;
  }
  const variance = timeSquare - time ** 2 / count;
  if (variance < 1e-8) return null;
  const dx = timeX - (time * x) / count;
  const dy = timeY - (time * y) / count;
  const magnitude = Math.hypot(dx, dy);
  return magnitude < 1e-8 ? null : { x: dx / magnitude, y: dy / magnitude };
}

function projectHeadContour(
  points: readonly PointV1[],
  cut: number,
  axis: PointV1,
): ArrowHeadPreparation {
  const anchor = points[cut]!;
  const local: PointV1[] = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let index = cut; index < points.length; index += 1) {
    const point = project(points[index]!, anchor, axis);
    local.push(point);
    includeBoundsPoint(bounds, point);
  }
  return { points: local, bounds };
}

function project(point: PointV1, anchor: PointV1, axis: PointV1): PointV1 {
  const x = point.x - anchor.x;
  const y = point.y - anchor.y;
  return { x: x * axis.x + y * axis.y, y: y * axis.x - x * axis.y };
}
