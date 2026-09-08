import type { PressureOutlinePiece } from "../../domain/geometry/pressure-outline";
import { quadraticPoint } from "../../domain/geometry/public";
import type { PointV1 } from "../../domain/schema/public";
import type { VisibleSelectionPrimitive } from "./selection-area-primitives";

const CURVE_SEGMENTS = 24;

/** Samples the painted closed contour, including only the outward half of each end cap. */
export function visitPressureSelectionPrimitives(
  piece: PressureOutlinePiece,
  visitor: (primitive: VisibleSelectionPrimitive) => boolean,
): boolean {
  if (piece.kind === "dot") {
    return visitor({
      kind: "capsule",
      start: piece.center,
      end: piece.center,
      radius: piece.radius,
    });
  }
  const points: PointV1[] = [];
  for (let step = 0; step <= CURVE_SEGMENTS; step += 1) {
    points.push(quadraticPoint(...piece.left, step / CURVE_SEGMENTS));
  }
  if (piece.endCap) appendCap(points, piece.end, piece.left[2], piece.endRadius);
  for (let step = CURVE_SEGMENTS; step >= 0; step -= 1) {
    points.push(quadraticPoint(...piece.right, step / CURVE_SEGMENTS));
  }
  if (piece.startCap) appendCap(points, piece.start, piece.right[0], piece.startRadius);
  return visitor({ kind: "polygon", points });
}

function appendCap(points: PointV1[], center: PointV1, first: PointV1, radius: number): void {
  const length = Math.hypot(first.x - center.x, first.y - center.y);
  const x = (first.y - center.y) / length;
  const y = -(first.x - center.x) / length;
  for (let step = 1; step < CURVE_SEGMENTS; step += 1) {
    const angle = (step / CURVE_SEGMENTS) * Math.PI;
    points.push({
      x: center.x + (first.x - center.x) * Math.cos(angle) + x * radius * Math.sin(angle),
      y: center.y + (first.y - center.y) * Math.cos(angle) + y * radius * Math.sin(angle),
    });
  }
}
