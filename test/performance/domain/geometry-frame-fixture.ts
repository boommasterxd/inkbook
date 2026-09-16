import type { buildPressureOutline } from "../../../src/domain/geometry/pressure-outline";
import type { canonicalizeGeometryNumber } from "../../../src/domain/schema/canonical";

export function measureCanonicalRoundingFrame(
  coordinates: readonly number[],
  frame: number,
  canonicalize: typeof canonicalizeGeometryNumber,
  checksum: number,
) {
  const factor = 0.53 + frame * 0.000137;
  const started = performance.now();
  for (const value of coordinates) checksum += canonicalize(value * factor);
  return { checksum, duration: performance.now() - started };
}

export function measurePressureResizeFrame(
  source: readonly { x: number; y: number; pressure: number }[],
  frame: number,
  build: typeof buildPressureOutline,
) {
  const scaleX = 0.35 + (frame % 173) * 0.0137;
  const scaleY = 0.61 + (frame % 137) * 0.0193;
  const started = performance.now();
  const centers = source.map((point) => ({
    x: 123456.789 + point.x * scaleX,
    y: -98765.432 + point.y * scaleY,
    pressure: point.pressure,
  }));
  const parts = build(centers, 22, { firstBoundary: 3, lastBoundary: 67 });
  return { parts, duration: performance.now() - started };
}
