import type { PointV1 } from "../../schema/types";
import { pressureRadius } from "./pressure-radius";

export interface PressureCenter extends PointV1 {
  readonly pressure: number;
}

export interface PressureNib {
  readonly center: PointV1;
  readonly radius: number;
}

export interface PressureBoundaryLine {
  readonly kind: "line";
  readonly start: PointV1;
  readonly end: PointV1;
}

export interface PressureBoundaryArc {
  readonly kind: "arc";
  readonly start: PointV1;
  readonly end: PointV1;
  readonly center: PointV1;
  readonly radius: number;
  /** Signed angular travel in SVG coordinates; negative is clockwise mathematically. */
  readonly sweep: number;
}

export interface PressureCapsule {
  readonly kind: "capsule";
  readonly start: PressureNib;
  readonly end: PressureNib;
  readonly left: PressureBoundaryLine;
  readonly right: PressureBoundaryLine;
  readonly startCap: PressureBoundaryArc;
  readonly endCap: PressureBoundaryArc;
}

export interface PressureDisk extends PressureNib {
  readonly kind: "dot";
}

/** Closed directed boundaries shared by exact unions and transient capsule paint. */
export function pressureShapeBoundary(
  shape: PressureCapsule | PressureDisk,
): (PressureBoundaryLine | PressureBoundaryArc)[] {
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

/** The convex hull of two nib disks, including the larger disk when one contains the other. */
export function buildPressureCapsule(
  first: PressureCenter,
  last: PressureCenter,
  width: number,
): PressureCapsule | PressureDisk {
  return buildPressureCapsuleFromNibs(
    preparePressureNib(first, width),
    preparePressureNib(last, width),
  );
}

/** Reuse a center's canonical radius across adjacent capsules in an outline. */
export function preparePressureNib(center: PressureCenter, width: number): PressureNib {
  return {
    center: { x: center.x, y: center.y },
    radius: pressureRadius(center.pressure, width),
  };
}

export function buildPressureCapsuleFromNibs(
  start: PressureNib,
  end: PressureNib,
): PressureCapsule | PressureDisk {
  const dx = end.center.x - start.center.x;
  const dy = end.center.y - start.center.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= Math.abs(start.radius - end.radius)) {
    return { kind: "dot", ...(start.radius >= end.radius ? start : end) };
  }
  const heading = Math.atan2(dy, dx);
  const spread = Math.acos((start.radius - end.radius) / distance);
  const left = tangent(start, end, heading + spread);
  const right = tangent(start, end, heading - spread);
  return {
    kind: "capsule",
    start,
    end,
    left,
    right,
    startCap: arc(start, right.start, left.start, 2 * spread - 2 * Math.PI),
    endCap: arc(end, left.end, right.end, -2 * spread),
  };
}

/** Sampling and serialization share the same directed circle, including major arcs. */
export function pressureArcPoint(
  boundary: PressureBoundaryArc,
  fraction: number,
  initial?: number,
): PointV1 {
  if (fraction === 0) return boundary.start;
  if (fraction === 1) return boundary.end;
  const angle =
    (initial ??
      Math.atan2(boundary.start.y - boundary.center.y, boundary.start.x - boundary.center.x)) +
    boundary.sweep * fraction;
  return {
    x: boundary.center.x + boundary.radius * Math.cos(angle),
    y: boundary.center.y + boundary.radius * Math.sin(angle),
  };
}

function tangent(start: PressureNib, end: PressureNib, angle: number): PressureBoundaryLine {
  const x = Math.cos(angle);
  const y = Math.sin(angle);
  return {
    kind: "line",
    start: { x: start.center.x + start.radius * x, y: start.center.y + start.radius * y },
    end: { x: end.center.x + end.radius * x, y: end.center.y + end.radius * y },
  };
}

function arc(
  circle: PressureNib,
  start: PointV1,
  end: PointV1,
  sweep: number,
): PressureBoundaryArc {
  return { kind: "arc", start, end, center: circle.center, radius: circle.radius, sweep };
}
