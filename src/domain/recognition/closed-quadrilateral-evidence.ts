import { pointDistance } from "../geometry/primitives";
import type { PointV1 } from "../schema/types";
import { fitClosedSides } from "./closed-side-fit";

/** Distinguish unequal adjacent sides from corner wobble and imperfect opposite-side agreement. */
export function hasUnequalParallelogramSides(
  points: readonly PointV1[],
  corners: readonly PointV1[],
  fitUncertainty: number,
): boolean {
  const fitted = fitClosedSides(points, corners);
  if (fitted === null) return false;
  corners = fitted.corners;
  fitUncertainty = Math.max(fitUncertainty, fitted.uncertainty);
  const lengths = corners.map((point, index) => pointDistance(point, corners[(index + 1) % 4]!));
  const oppositeDifference =
    Math.abs(lengths[0]! - lengths[2]!) + Math.abs(lengths[1]! - lengths[3]!);
  const adjacentDifference = Math.abs((lengths[0]! + lengths[2]! - lengths[1]! - lengths[3]!) / 2);
  const firstMidpoint = {
    x: (corners[0]!.x + corners[2]!.x) / 2,
    y: (corners[0]!.y + corners[2]!.y) / 2,
  };
  const secondMidpoint = {
    x: (corners[1]!.x + corners[3]!.x) / 2,
    y: (corners[1]!.y + corners[3]!.y) / 2,
  };
  // These two measures describe the same corner disagreement. Use the larger
  // estimate without charging that disagreement twice.
  const coherenceError = Math.max(
    oppositeDifference,
    pointDistance(firstMidpoint, secondMidpoint) * 2,
  );
  return adjacentDifference > coherenceError + fitUncertainty;
}
