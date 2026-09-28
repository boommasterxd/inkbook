import type { PointV1 } from "../schema/types";
import type { PressureBoundarySegment } from "./pressure-boundary-intersections";
import type {
  PressureBoundaryLine,
  PressureCapsule,
  PressureDisk,
  PressureNib,
} from "./pressure-joins";

interface Side {
  readonly original: PressureBoundaryLine;
  start: PointV1;
  end: PointV1;
  first: number;
  last: number;
  join?: PressureBoundarySegment;
}

/** Regular connected nib sweeps need only adjacent tangent joins, not a Boolean arrangement. */
export function pressureChainContour(
  shapes: readonly (PressureCapsule | PressureDisk)[],
): PressureBoundarySegment[] | undefined {
  if (shapes.length < 2 || shapes.some((shape) => shape.kind !== "capsule")) return undefined;
  const capsules = shapes as readonly PressureCapsule[];
  for (let index = 1; index < capsules.length; index += 1) {
    if (!sameNib(capsules[index - 1]!.end, capsules[index]!.start)) return undefined;
  }
  const left = capsules.map((capsule) => side(capsule.left));
  const right = [...capsules]
    .reverse()
    .map((capsule) => side({ kind: "line", start: capsule.right.end, end: capsule.right.start }));
  for (let index = 1; index < capsules.length; index += 1) {
    if (!join(left[index - 1]!, left[index]!, capsules[index]!.start)) return undefined;
    if (!join(right[index - 1]!, right[index]!, capsules[capsules.length - index]!.start))
      return undefined;
  }
  return [
    ...segments(left),
    capsules[capsules.length - 1]!.endCap,
    ...segments(right),
    capsules[0]!.startCap,
  ];
}

function sameNib(first: PressureNib, last: PressureNib): boolean {
  return (
    first.center.x === last.center.x &&
    first.center.y === last.center.y &&
    first.radius === last.radius
  );
}
function side(original: PressureBoundaryLine): Side {
  return { original, start: original.start, end: original.end, first: 0, last: 1 };
}
function segments(sides: readonly Side[]): PressureBoundarySegment[] {
  return sides.flatMap((value) => {
    const line: PressureBoundaryLine = { kind: "line", start: value.start, end: value.end };
    return value.join === undefined ? [line] : [line, value.join];
  });
}

function join(first: Side, last: Side, nib: PressureNib): boolean {
  const ax = first.end.x - nib.center.x;
  const ay = first.end.y - nib.center.y;
  const bx = last.start.x - nib.center.x;
  const by = last.start.y - nib.center.y;
  const angle = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  if (Math.abs(angle) >= Math.PI) return false;
  if (angle < 0) {
    first.join = {
      kind: "arc",
      start: first.end,
      end: last.start,
      center: nib.center,
      radius: nib.radius,
      sweep: angle,
    };
    return true;
  }
  if (first.end.x === last.start.x && first.end.y === last.start.y) return true;
  if (angle === 0) return false;
  return trimInnerJoin(first, last);
}

function trimInnerJoin(first: Side, last: Side): boolean {
  const a = first.original;
  const b = last.original;
  const ax = a.end.x - a.start.x;
  const ay = a.end.y - a.start.y;
  const bx = b.end.x - b.start.x;
  const by = b.end.y - b.start.y;
  const determinant = ax * by - ay * bx;
  if (determinant === 0) return false;
  const dx = b.start.x - a.start.x;
  const dy = b.start.y - a.start.y;
  const t = (dx * by - dy * bx) / determinant;
  const u = (dx * ay - dy * ax) / determinant;
  if (t < first.first || t > first.last || u < last.first || u > last.last) return false;
  const point = { x: a.start.x + t * ax, y: a.start.y + t * ay };
  first.last = t;
  first.end = point;
  last.first = u;
  last.start = point;
  return true;
}
