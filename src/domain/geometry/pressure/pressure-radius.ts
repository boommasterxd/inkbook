import { canonicalGeometryNumber } from "../svg-format";

/** The persisted pressure-to-width law shared by current and historical contours. */
export function pressureRadius(pressure: number, width: number): number {
  return canonicalGeometryNumber((width * (0.35 + 0.65 * Math.max(0, Math.min(1, pressure)))) / 2);
}
