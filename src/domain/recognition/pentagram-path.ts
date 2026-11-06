import { pointDistance, pointSegmentDistance, segmentsIntersect } from "../geometry/primitives";
import type { PointV1 } from "../schema/types";
import { closedContourCorners } from "./closed-contour-corners";

interface PathOptions {
  readonly diagonal: number;
  readonly zoom: number;
  readonly gap: number;
}

/** Simplification identifies outer turns; topology and every original point still decide admission. */
export function preparePentagramPath(
  points: readonly PointV1[],
  options: PathOptions,
): PointV1[] | null {
  const tolerance = Math.max(2 / options.zoom, options.diagonal * 0.018);
  const coarseTolerance = Math.max(tolerance, options.diagonal * 0.04);
  let tips = extractTips(points, tolerance);
  if (tips.length !== 5 && coarseTolerance > tolerance) tips = extractTips(points, coarseTolerance);
  if (tips.length !== 5 || !hasPentagramTopology(tips)) return null;
  return followsTipEdges(points, tips, options) ? tips : null;
}

function extractTips(points: readonly PointV1[], tolerance: number): PointV1[] {
  const tips = closedContourCorners(points, tolerance);
  while (tips.length > 5) {
    let selected = -1;
    let weakest = 0.5;
    for (let index = 0; index < tips.length; index++) {
      const before = tips[(index + tips.length - 1) % tips.length]!;
      const point = tips[index]!;
      const after = tips[(index + 1) % tips.length]!;
      const ax = point.x - before.x;
      const ay = point.y - before.y;
      const bx = after.x - point.x;
      const by = after.y - point.y;
      const cosine = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
      if (cosine > weakest) {
        weakest = cosine;
        selected = index;
      }
    }
    if (selected < 0) break;
    tips.splice(selected, 1);
  }
  if (tips.length === 6 && pointDistance(tips[0]!, tips[5]!) <= tolerance * 2) {
    const center = tips
      .slice(1, -1)
      .reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
    if (pointDistance(tips[0]!, center) >= pointDistance(tips[5]!, center)) tips.pop();
    else tips.shift();
  }
  if (tips.length === 5) retainOuterSeamPoint(tips, points, tolerance);
  return tips;
}

/** RDP's mandatory start sample must not make the same closing tip depend on drawing direction. */
function retainOuterSeamPoint(
  tips: PointV1[],
  points: readonly PointV1[],
  tolerance: number,
): void {
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const index = tips.findIndex(
    (tip) => pointDistance(tip, start) <= tolerance * 2 && pointDistance(tip, end) <= tolerance * 2,
  );
  if (index < 0) return;
  const others = tips.filter((_, offset) => offset !== index);
  const center = others.reduce(
    (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  const endpoint = pointDistance(start, center) >= pointDistance(end, center) ? start : end;
  if (pointDistance(endpoint, center) <= pointDistance(tips[index]!, center)) return;
  tips.splice(index, 1);
  if (endpoint === start) tips.unshift(endpoint);
  else tips.push(endpoint);
}

function hasPentagramTopology(tips: readonly PointV1[]): boolean {
  const center = tips.reduce((sum, point) => ({ x: sum.x + point.x / 5, y: sum.y + point.y / 5 }), {
    x: 0,
    y: 0,
  });
  const ordered = [...tips].sort(
    (a, b) =>
      Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x),
  );
  for (let index = 0; index < 5; index++) {
    const a = ordered[index]!;
    const b = ordered[(index + 1) % 5]!;
    const c = ordered[(index + 2) % 5]!;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return false;
  }
  const ranks = tips.map((tip) => ordered.indexOf(tip));
  const step = (ranks[1]! - ranks[0]! + 5) % 5;
  if (step !== 2 && step !== 3) return false;
  if (ranks.some((rank, index) => (ranks[(index + 1) % 5]! - rank + 5) % 5 !== step)) return false;
  let crossings = 0;
  for (let index = 0; index < 5; index++) {
    for (let other = index + 1; other < 5; other++) {
      if (other === index + 1 || (other + 1) % 5 === index) continue;
      if (
        segmentsIntersect(
          tips[index]!,
          tips[(index + 1) % 5]!,
          tips[other]!,
          tips[(other + 1) % 5]!,
        )
      )
        crossings++;
    }
  }
  return crossings === 5;
}

function followsTipEdges(
  points: readonly PointV1[],
  tips: readonly PointV1[],
  options: PathOptions,
): boolean {
  const perimeter = tips.reduce(
    (sum, point, index) => sum + pointDistance(point, tips[(index + 1) % 5]!),
    0,
  );
  let length = options.gap;
  let square = 0;
  let maximum = 0;
  let nextTip = 0;
  let edge = 4;
  let previous = points[0]!;
  for (const point of points) {
    if (point === tips[nextTip]) {
      edge = nextTip;
      nextTip++;
    }
    const distance = pointSegmentDistance(point, tips[edge]!, tips[(edge + 1) % 5]!);
    square += distance * distance;
    maximum = Math.max(maximum, distance);
    length += pointDistance(previous, point);
    previous = point;
  }
  return (
    nextTip === 5 &&
    length <= perimeter * 1.12 &&
    length >= perimeter * 0.94 &&
    Math.sqrt(square / points.length) <= options.diagonal * 0.026 &&
    maximum <= options.diagonal * 0.065
  );
}
