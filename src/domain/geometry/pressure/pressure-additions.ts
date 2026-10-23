import type { PointV1 } from "../../schema/types";

export type PressureTriangle = readonly PointV1[];
export interface PressureAdditionCount {
  count: number;
}
export type PressureAdditions = PressureTriangle[] | PressureAdditionCount;
export type PressureAdditionRecorder =
  PressureAdditions | ((triangle: PressureTriangle) => void) | undefined;

/** Count-only path consumers retain the same capacity decisions without selection geometry. */
export function recordPressureAddition(
  target: PressureAdditionRecorder,
  first: PointV1,
  middle: PointV1,
  last: PointV1,
): void {
  if (Array.isArray(target)) target.push([first, middle, last]);
  else if (typeof target === "function") target([first, middle, last]);
  else if (target !== undefined) target.count += 1;
}

export function pressureAdditionCount(target: PressureAdditions): number {
  return Array.isArray(target) ? target.length : target.count;
}
