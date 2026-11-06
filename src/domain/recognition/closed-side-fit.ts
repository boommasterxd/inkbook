import type { PointV1 } from "../schema/types";

interface Moments {
  weight: number;
  count: number;
  x: number;
  y: number;
  xx: number;
  xy: number;
  yy: number;
}

interface SideLine {
  center: PointV1;
  dx: number;
  dy: number;
  residual: number;
}

interface SideEdge {
  x: number;
  y: number;
  dx: number;
  dy: number;
  squared: number;
}

/** Rounded corner samples identify sides; their interior traces determine the actual lines. */
export function fitClosedSides(points: readonly PointV1[], corners: readonly PointV1[]) {
  if (corners.length !== 4) return null;
  const positions = corners.map((point) => ({ x: point.x, y: point.y }));
  const edges: SideEdge[] = positions.map((start, index) => {
    const end = positions[(index + 1) % 4]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return { ...start, dx, dy, squared: dx * dx + dy * dy };
  });
  const moments: Moments[] = corners.map(() => ({
    weight: 0,
    count: 0,
    x: 0,
    y: 0,
    xx: 0,
    xy: 0,
    yy: 0,
  }));
  let before = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    const x = point.x;
    const y = point.y;
    const next = points[Math.min(index + 1, points.length - 1)]!;
    const after = Math.hypot(next.x - x, next.y - y);
    const edge = nearestEdge(x, y, edges);
    if (edge.t >= 0.2 && edge.t <= 0.8) {
      const origin = edges[edge.index]!;
      record(moments[edge.index]!, x - origin.x, y - origin.y, before + after);
    }
    before = after;
  }
  const lines = moments.map((moment, index) => fitLine(moment, edges[index]!));
  if (lines.some((line) => line === null)) return null;
  const fitted = lines.map((line, index) => intersect(lines[(index + 3) % 4]!, line));
  if (fitted.some((point) => point === null)) return null;
  return {
    corners: fitted as PointV1[],
    uncertainty: Math.max(...lines.map((line) => line!.residual)) * 2,
  };
}

function nearestEdge(x: number, y: number, edges: readonly SideEdge[]) {
  let result = { index: 0, t: 0, squared: Infinity };
  for (let index = 0; index < 4; index++) {
    const edge = edges[index]!;
    const t = Math.max(
      0,
      Math.min(1, ((x - edge.x) * edge.dx + (y - edge.y) * edge.dy) / edge.squared),
    );
    const squared = (x - edge.x - t * edge.dx) ** 2 + (y - edge.y - t * edge.dy) ** 2;
    if (squared < result.squared) result = { index, t, squared };
  }
  return result;
}

function record(moment: Moments, x: number, y: number, weight: number): void {
  moment.weight += weight;
  moment.count++;
  moment.x += x * weight;
  moment.y += y * weight;
  moment.xx += x * x * weight;
  moment.xy += x * y * weight;
  moment.yy += y * y * weight;
}

function fitLine(moment: Moments, origin: PointV1): SideLine | null {
  if (moment.count < 3 || moment.weight <= 0) return null;
  const x = moment.x / moment.weight;
  const y = moment.y / moment.weight;
  const xx = moment.xx / moment.weight - x * x;
  const xy = moment.xy / moment.weight - x * y;
  const yy = moment.yy / moment.weight - y * y;
  if (!(xx + yy > 0)) return null;
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  const residual = Math.sqrt(Math.max(0, (xx + yy - Math.hypot(xx - yy, 2 * xy)) / 2));
  return {
    center: { x: origin.x + x, y: origin.y + y },
    dx: Math.cos(angle),
    dy: Math.sin(angle),
    residual,
  };
}

function intersect(first: SideLine | null, second: SideLine | null): PointV1 | null {
  if (first === null || second === null) return null;
  const determinant = first.dx * second.dy - first.dy * second.dx;
  if (Math.abs(determinant) < 1e-6) return null;
  const x = second.center.x - first.center.x;
  const y = second.center.y - first.center.y;
  const t = (x * second.dy - y * second.dx) / determinant;
  const point = { x: first.center.x + first.dx * t, y: first.center.y + first.dy * t };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}
