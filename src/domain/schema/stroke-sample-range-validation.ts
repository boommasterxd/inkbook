import type { PointV1 } from "./types";
import type { StrokeSampleExtrema } from "./stroke-sample-extrema";
import {
  assertGeometryNumber,
  assertUnitInterval,
  fail,
  type ValidationContext,
} from "./validation-internals";

// One indivisible validation leaf; the producer controls its bounded triple range.
export function assertStrokeSampleRange(
  value: unknown[] | Float64Array,
  path: string,
  context: ValidationContext,
  offset: PointV1 | undefined,
  range: { readonly start: number; readonly end: number },
): StrokeSampleExtrema {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = range.start; index < range.end; index += 3) {
    const x: unknown = value[index];
    const y: unknown = value[index + 1];
    const pressure: unknown = value[index + 2];
    assertGeometryNumber(x, `${path}[${index}]`, context.limits.absoluteCoordinate);
    assertGeometryNumber(y, `${path}[${index + 1}]`, context.limits.absoluteCoordinate);
    assertUnitInterval(pressure, `${path}[${index + 2}]`);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    if (
      offset !== undefined &&
      (Math.abs(x + offset.x) > context.limits.absoluteCoordinate ||
        Math.abs(y + offset.y) > context.limits.absoluteCoordinate)
    ) {
      fail("invalid-range", path, "Translated stroke coordinates exceed the numeric limit.");
    }
  }
  return { minX, minY, maxX, maxY };
}
