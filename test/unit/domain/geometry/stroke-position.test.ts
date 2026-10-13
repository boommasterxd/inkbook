import { describe, expect, it } from "vitest";
import { calculateElementBounds } from "../../../../src/domain/geometry/bounds";
import { transformedStrokeCenters } from "../../../../src/domain/geometry/stroke-path";
import { strokeCenterWindow } from "../../../../src/domain/geometry/stroke-center-window";
import {
  strokeLocalGeometry,
  strokeWorldPoint,
  translatedStroke,
} from "../../../../src/domain/geometry/stroke-position";
import { stroke } from "../schema/fixtures";

describe("stroke shape and position", () => {
  it.each([0, 37, 90])(
    "preserves local contours under repeated moves at %s degrees",
    (rotation) => {
      const source = { ...stroke(), rotation };
      const first = translatedStroke(source, { x: 120, y: -80 });
      const moved = translatedStroke(first, { x: -20, y: 30 });
      expect(moved.points).toBe(source.points);
      expect(strokeLocalGeometry(source)).toBe(source);
      expect(strokeLocalGeometry(moved)).toEqual(source);
      expect(moved.offset).toEqual({ x: 100, y: -50 });
      const expected = transformedStrokeCenters(source).map((center) => ({
        ...center,
        x: center.x + 100,
        y: center.y - 50,
      }));
      const actual = strokeCenterWindow(moved, 0, { validate: true });
      actual.forEach((center, index) => {
        expect(center.x).toBeCloseTo(expected[index]!.x, 9);
        expect(center.y).toBeCloseTo(expected[index]!.y, 9);
        expect(center.pressure).toBe(expected[index]!.pressure);
      });
      const before = calculateElementBounds(source);
      const after = calculateElementBounds(moved);
      expect(after.minX).toBeCloseTo(before.minX + 100, 9);
      expect(after.maxY).toBeCloseTo(before.maxY - 50, 9);
    },
  );

  it("uses the world pivot after applying the sample offset", () => {
    const positioned = { ...stroke(), offset: { x: 100, y: 50 }, rotation: 90 };
    expect(strokeWorldPoint(positioned, { x: 10, y: 70 })).toEqual({ x: 100, y: 110 });
    expect(strokeLocalGeometry(positioned).pivot).toEqual({ x: 10, y: 60 });
  });
});
