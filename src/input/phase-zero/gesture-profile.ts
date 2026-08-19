export const INPUT_GESTURE_PROFILE_V1 = {
  pinchDistanceSlopScreenPx: 8,
  longPressDelayMs: 500,
  longPressMovementSlopScreenPx: 8,
  secondaryButtonPanSlopScreenPx: 8,
} as const;

export type ScreenPoint = Readonly<{
  x: number;
  y: number;
}>;

export type PointerKind = "mouse" | "pen" | "touch";

export type PointerSample = Readonly<{
  pointerId: number;
  clientX: number;
  clientY: number;
}>;

export function isValidPointerSample(sample: PointerSample): boolean {
  return (
    Number.isSafeInteger(sample.pointerId) &&
    sample.pointerId >= 0 &&
    Number.isFinite(sample.clientX) &&
    Number.isFinite(sample.clientY)
  );
}

export function toScreenPoint(sample: PointerSample): ScreenPoint {
  return { x: sample.clientX, y: sample.clientY };
}

export function normalizePointerKind(value: string): PointerKind {
  if (value === "pen" || value === "touch") return value;
  return "mouse";
}
