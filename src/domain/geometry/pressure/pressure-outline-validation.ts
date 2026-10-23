import { MAX_STROKE_POINTS } from "../../schema/constants";
import type { PointV1 } from "../../schema/types";

interface PressurePoint extends PointV1 {
  readonly pressure: number;
}

export function assertPressureOutlineInput(centers: readonly PressurePoint[], width: number): void {
  if (
    centers.length < 1 ||
    centers.length > MAX_STROKE_POINTS ||
    !Number.isFinite(width) ||
    width <= 0
  ) {
    throw new RangeError(
      `Pressure outlines require 1 through ${MAX_STROKE_POINTS} centers and a positive finite width.`,
    );
  }
  for (const center of centers) {
    if (
      !Number.isFinite(center.x) ||
      !Number.isFinite(center.y) ||
      !Number.isFinite(center.pressure)
    ) {
      throw new RangeError("Pressure outlines require finite centers.");
    }
  }
}
