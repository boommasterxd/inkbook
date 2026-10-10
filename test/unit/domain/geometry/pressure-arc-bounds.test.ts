import { describe, expect, it, vi } from "vitest";
import * as arcBounds from "../../../../src/domain/geometry/pressure-arc-bounds";
import {
  buildPressureCapsule,
  pressureArcPoint,
  type PressureBoundaryArc,
} from "../../../../src/domain/geometry/pressure-joins";
import { iteratePressureUnion } from "../../../../src/domain/geometry/pressure-union";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";

function arc(initial: number, sweep: number, x = 0, y = 0, radius = 5): PressureBoundaryArc {
  return {
    kind: "arc",
    center: { x, y },
    radius,
    start: { x: x + radius * Math.cos(initial), y: y + radius * Math.sin(initial) },
    end: { x: x + radius * Math.cos(initial + sweep), y: y + radius * Math.sin(initial + sweep) },
    sweep,
  };
}

function fullCircleBounds(boundary: PressureBoundaryArc) {
  const { center, radius } = boundary;
  const pad =
    128 * Number.EPSILON * Math.max(1, Math.abs(center.x) + radius, Math.abs(center.y) + radius);
  return {
    minX: center.x - radius - pad,
    minY: center.y - radius - pad,
    maxX: center.x + radius + pad,
    maxY: center.y + radius + pad,
  };
}

describe("conservative source arc bounds", () => {
  it.each([
    [0, Math.PI, -5, 0, 5, 5],
    [0, -Math.PI, -5, -5, 5, 0],
    [(3 * Math.PI) / 2, Math.PI, 0, -5, 5, 5],
    [Math.PI / 2, -Math.PI, 0, -5, 5, 5],
    [(-3 * Math.PI) / 4, Math.PI / 2, -Math.SQRT1_2 * 5, -5, Math.SQRT1_2 * 5, -Math.SQRT1_2 * 5],
  ])("includes directed extrema from %f through %f", (initial, sweep, minX, minY, maxX, maxY) => {
    const bounds = arcBounds.pressureArcBounds(arc(initial, sweep), new WeakMap());
    expect(bounds.minX).toBeCloseTo(minX, 10);
    expect(bounds.minY).toBeCloseTo(minY, 10);
    expect(bounds.maxX).toBeCloseTo(maxX, 10);
    expect(bounds.maxY).toBeCloseTo(maxY, 10);
  });

  it.each([
    [0, Math.PI / 2 - Number.EPSILON],
    [Math.PI / 2 + Number.EPSILON, -Math.PI / 2],
    [2 * Math.PI - 1e-12, 1e-11],
    [-Math.PI + 1e-12, -Math.PI - 1e-12],
    [Math.PI / 3, 1.9 * Math.PI],
  ])("contains points near cardinal and wrap boundaries (%f, %f)", (initial, sweep) => {
    for (const [x, y] of [
      [0, 0],
      [999_980, -999_980],
    ] as const) {
      const boundary = arc(initial, sweep, x, y);
      const bounds = arcBounds.pressureArcBounds(boundary, new WeakMap());
      for (let index = 0; index <= 128; index += 1) {
        const point = pressureArcPoint(boundary, index / 128);
        expect(point.x).toBeGreaterThanOrEqual(bounds.minX);
        expect(point.x).toBeLessThanOrEqual(bounds.maxX);
        expect(point.y).toBeGreaterThanOrEqual(bounds.minY);
        expect(point.y).toBeLessThanOrEqual(bounds.maxY);
      }
    }
  });

  it.each([0, Number.EPSILON, 2 * Math.PI, -2 * Math.PI, 3 * Math.PI, Number.NaN])(
    "retains the full carrier for unresolved sweep %f",
    (sweep) => {
      const boundary = arc(0, sweep);
      expect(arcBounds.pressureArcBounds(boundary, new WeakMap())).toEqual(
        fullCircleBounds(boundary),
      );
    },
  );

  it("keeps degenerate or inconsistent carriers and preserves padded endpoint coordinates", () => {
    for (const boundary of [
      arc(0, Math.PI, 1_000_000, 1_000_000, 0),
      arc(0, Math.PI, 1_000_000, 1_000_000, Number.EPSILON),
      { ...arc(0, Math.PI), end: { x: 0, y: 0 } },
    ])
      expect(arcBounds.pressureArcBounds(boundary, new WeakMap())).toEqual(
        fullCircleBounds(boundary),
      );
    const boundary = arc(0, Math.PI);
    const displaced = { ...boundary, start: { x: boundary.start.x + 1e-13, y: boundary.start.y } };
    expect(arcBounds.pressureArcBounds(displaced, new WeakMap()).maxX).toBeGreaterThan(
      displaced.start.x,
    );
  });

  it("reuses the exact predicate's source-angle cache", () => {
    const boundary = arc(-Math.PI / 3, Math.PI);
    const cache = new WeakMap([[boundary, -Math.PI / 3]]);
    const angles = vi.spyOn(Math, "atan2");
    try {
      arcBounds.pressureArcBounds(boundary, cache);
      expect(angles).not.toHaveBeenCalled();
      arcBounds.pressureArcBounds(boundary, new WeakMap());
      expect(angles).toHaveBeenCalledTimes(1);
    } finally {
      angles.mockRestore();
    }
  });
});

describe("query and source arc rejection exact-output parity", () => {
  it.each([
    { count: 2, offset: 0, width: 8 },
    { count: 16, offset: 0, width: 8 },
    { count: 64, offset: 0, width: 8 },
    { count: 16, offset: 999_980, width: 0.001 },
    { count: 16, offset: -999_980, width: 0.35 },
    { count: 16, offset: 999_980, width: 1e-10 },
  ])(
    "preserves contour coordinates and fallback ($count sources, $offset offset, $width width)",
    ({ count, offset, width }) => {
      const shapes = Array.from({ length: count }, (_, index) =>
        buildPressureCapsule(
          { x: offset + (index % 8), y: Math.floor(index / 8), pressure: (index % 5) / 4 },
          {
            x: offset + ((index + 1) % 8),
            y: Math.floor((index + 1) / 8),
            pressure: ((index + 1) % 5) / 4,
          },
          width,
        ),
      );
      const actual = finishGeometrySteps(iteratePressureUnion(shapes));
      const bounds = vi.spyOn(arcBounds, "pressureArcBounds").mockImplementation(fullCircleBounds);
      try {
        const reference = finishGeometrySteps(iteratePressureUnion(shapes));
        expect(actual.contours).toEqual(reference.contours);
        expect(actual.usedFallback).toBe(reference.usedFallback);
        expect(actual.work.intersectionTests).toBeLessThanOrEqual(reference.work.intersectionTests);
        expect(actual.work.boundaryTests).toBeLessThanOrEqual(reference.work.boundaryTests);
      } finally {
        bounds.mockRestore();
      }
    },
  );
});
