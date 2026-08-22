import { describe, expect, it } from "vitest";

import {
  canonicalPoint,
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
});
