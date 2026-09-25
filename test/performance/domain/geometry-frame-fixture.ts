import type { buildPressureOutline } from "../../../src/domain/geometry/pressure-outline";
export function buildPressureResizeFrame(
  source: readonly { x: number; y: number; pressure: number }[],
  frame: number,
  build: typeof buildPressureOutline,
) {
  const scaleX = 0.35 + (frame % 173) * 0.0137;
  const scaleY = 0.61 + (frame % 137) * 0.0193;
  const centers = source.map((point) => ({
    x: 123456.789 + point.x * scaleX,
    y: -98765.432 + point.y * scaleY,
    pressure: point.pressure,
  }));
  return build(centers, 22);
}
