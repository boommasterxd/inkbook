import type { PressureBoundaryArc } from "./pressure-joins";
import type { PressureArcAngleCache } from "./pressure-boundary-intersections";

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const TURN = 2 * Math.PI;
const ANGLE_ERROR = 64 * Number.EPSILON * TURN;

/** Conservative source-arc rejection only; exact intersection predicates remain authoritative. */
export function pressureArcBounds(arc: PressureBoundaryArc, angles: PressureArcAngleCache): Bounds {
  const full = {
    minX: arc.center.x - arc.radius,
    minY: arc.center.y - arc.radius,
    maxX: arc.center.x + arc.radius,
    maxY: arc.center.y + arc.radius,
  };
  // Keep the former full-circle padding, including its coordinate magnitude.
  const pad =
    128 *
    Number.EPSILON *
    Math.max(1, Math.abs(full.minX), Math.abs(full.minY), Math.abs(full.maxX), Math.abs(full.maxY));
  const sweep = Math.abs(arc.sweep);
  if (
    !Number.isFinite(sweep) ||
    !Number.isFinite(pad) ||
    arc.radius <= pad ||
    sweep <= ANGLE_ERROR ||
    sweep >= TURN - ANGLE_ERROR
  )
    return padded(full, pad);
  let initial = angles.get(arc);
  if (initial === undefined) {
    initial = Math.atan2(arc.start.y - arc.center.y, arc.start.x - arc.center.x);
    angles.set(arc, initial);
  }
  const first = circlePoint(arc, initial);
  const last = circlePoint(arc, initial + arc.sweep);
  // Inconsistent or unresolved endpoint geometry cannot safely narrow the carrier.
  if (!nearEndpoint(first, arc.start, pad) || !nearEndpoint(last, arc.end, pad))
    return padded(full, pad);
  const bounds = {
    minX: Math.min(first.x, last.x, arc.start.x, arc.end.x),
    minY: Math.min(first.y, last.y, arc.start.y, arc.end.y),
    maxX: Math.max(first.x, last.x, arc.start.x, arc.end.x),
    maxY: Math.max(first.y, last.y, arc.start.y, arc.end.y),
  };
  for (let index = 0; index < 4; index += 1) {
    const angle = (index * Math.PI) / 2;
    const travel = ((((angle - initial) * Math.sign(arc.sweep)) % TURN) + TURN) % TURN;
    if (travel > sweep + ANGLE_ERROR) continue;
    includeCardinal(bounds, arc, index);
  }
  return padded(bounds, pad);
}

function circlePoint(arc: PressureBoundaryArc, angle: number): { x: number; y: number } {
  return {
    x: arc.center.x + arc.radius * Math.cos(angle),
    y: arc.center.y + arc.radius * Math.sin(angle),
  };
}

function nearEndpoint(
  first: { x: number; y: number },
  last: { x: number; y: number },
  pad: number,
): boolean {
  return Math.abs(first.x - last.x) <= pad && Math.abs(first.y - last.y) <= pad;
}

function includeCardinal(bounds: Bounds, arc: PressureBoundaryArc, index: number): void {
  if (index === 0) bounds.maxX = Math.max(bounds.maxX, arc.center.x + arc.radius);
  else if (index === 1) bounds.maxY = Math.max(bounds.maxY, arc.center.y + arc.radius);
  else if (index === 2) bounds.minX = Math.min(bounds.minX, arc.center.x - arc.radius);
  else bounds.minY = Math.min(bounds.minY, arc.center.y - arc.radius);
}

function padded(bounds: Bounds, pad: number): Bounds {
  return {
    minX: bounds.minX - pad,
    minY: bounds.minY - pad,
    maxX: bounds.maxX + pad,
    maxY: bounds.maxY + pad,
  };
}
