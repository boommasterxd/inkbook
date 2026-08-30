import { describe, expect, it } from "vitest";
import type { PointV1 } from "../../../../src/domain/schema/public";
import { boundsFromPoints } from "../../../../src/domain/geometry/primitives";

import {
  canonicalPoint,
  linearPivot,
  normalizeRotation,
  pointInPolygon,
  quadraticBounds,
  quadraticPoint,
  rotatePointClockwise,
  roundCanonical,
} from "../../../../src/domain/geometry/public";

describe("canonical geometry primitives", () => {
  it("rounds geometry and removes negative zero", () => {
    expect(roundCanonical(1.23456)).toBe(1.235);
    expect(roundCanonical(0.12345, 4)).toBe(0.1235);
    expect(roundCanonical(-0.0001)).toBe(0);
    expect(canonicalPoint({ x: 2.3456, y: -0.0002 })).toEqual({ x: 2.346, y: 0 });
    expect(() => roundCanonical(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("normalizes clockwise rotations to the canonical interval", () => {
    expect(normalizeRotation(180)).toBe(-180);
    expect(normalizeRotation(540)).toBe(-180);
    expect(normalizeRotation(-181)).toBe(179);
    expect(normalizeRotation(360.1254)).toBe(0.125);
    expect(() => normalizeRotation(Number.NaN)).toThrow(RangeError);
  });

  it("rotates page points clockwise around their pivot", () => {
    const rotated = rotatePointClockwise({ x: 20, y: 10 }, { x: 10, y: 10 }, 90);
    expect(rotated.x).toBeCloseTo(10);
    expect(rotated.y).toBeCloseTo(20);
  });

  it("derives canonical linear pivots from straight and bent bounds", () => {
    expect(linearPivot({ x: 2, y: 4 }, { x: 10, y: 8 }, null)).toEqual({ x: 6, y: 6 });
    expect(linearPivot({ x: 2, y: 4 }, { x: 10, y: 8 }, { x: 6.1234, y: 20.5678 })).toEqual({
      x: 6,
      y: 12.284,
    });
  });

  it("classifies interior and exterior polygon points", () => {
    const triangle = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 4 }, triangle)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 11 }, triangle)).toBe(false);
  });

  it("includes exact quadratic extrema in curve bounds", () => {
    const start = { x: 0, y: 0 };
    const control = { x: 10, y: 20 };
    const end = { x: 20, y: 0 };
    expect(quadraticPoint(start, control, end, 0.5)).toEqual({ x: 10, y: 10 });
    expect(quadraticBounds(start, control, end)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 10 });
  });

  it("rejects empty bounds and ignores sparse point entries", () => {
    expect(() => boundsFromPoints([])).toThrow("at least one point");
    const points = new Array<PointV1>(3);
    points[0] = { x: 2, y: 3 };
    points[2] = { x: 8, y: 9 };
    expect(boundsFromPoints(points)).toEqual({ minX: 2, minY: 3, maxX: 8, maxY: 9 });
  });
});
