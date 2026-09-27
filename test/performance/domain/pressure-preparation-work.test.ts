import { describe, expect, it, vi } from "vitest";
import * as intersections from "../../../src/domain/geometry/pressure-boundary-intersections";
import { pressureArcPoint } from "../../../src/domain/geometry/pressure-joins";
import { visitPreparedPressureOutline } from "../../../src/domain/geometry/pressure-outline";
import * as pressureRadius from "../../../src/domain/geometry/pressure-radius";
import { pressureShapeBoundary } from "../../../src/domain/geometry/pressure-union";

describe("bounded pressure preparation work", () => {
  it.each([
    { first: 0, last: 64, stopAfterFirst: false, expectedNibs: 65, expectedPieces: 64 },
    { first: 16, last: 32, stopAfterFirst: false, expectedNibs: 17, expectedPieces: 16 },
    { first: 0, last: 64, stopAfterFirst: true, expectedNibs: 2, expectedPieces: 1 },
    { first: 32, last: 32, stopAfterFirst: false, expectedNibs: 0, expectedPieces: 0 },
  ])(
    "canonicalizes each visited center once (slice $first..$last, stop: $stopAfterFirst)",
    ({ first, last, stopAfterFirst, expectedNibs, expectedPieces }) => {
      const centers = Array.from({ length: 65 }, (_, index) => ({
        x: index * 3,
        y: Math.sin(index / 4) * 10,
        pressure: 0.25 + (index % 5) * 0.15,
      }));
      const radii = vi.spyOn(pressureRadius, "pressureRadius");
      let pieces = 0;
      try {
        const stopped = visitPreparedPressureOutline(
          centers,
          2,
          () => {
            pieces += 1;
            return stopAfterFirst;
          },
          { firstBoundary: first, lastBoundary: last },
        );
        expect(stopped).toBe(stopAfterFirst);
        expect(pieces).toBe(expectedPieces);
        expect(radii).toHaveBeenCalledTimes(expectedNibs);
      } finally {
        radii.mockRestore();
      }
    },
  );

  it("reuses an unchanged arc's start angle across repeated boundary probes", () => {
    const [boundary] = pressureShapeBoundary({
      kind: "dot",
      center: { x: 40, y: -25 },
      radius: 10,
    });
    if (boundary?.kind !== "arc") throw new Error("Expected arc boundary.");
    const points = Array.from({ length: 64 }, (_, index) =>
      pressureArcPoint(boundary, (index + 1) / 65),
    );
    const angles = vi.spyOn(Math, "atan2");
    try {
      const independent = points.map((point) =>
        intersections.pressureBoundaryParameter(boundary, point),
      );
      const independentCalls = angles.mock.calls.length;
      angles.mockClear();
      const cache = new WeakMap();
      const prepared = points.map((point) =>
        intersections.pressureBoundaryParameter(boundary, point, cache),
      );
      expect(prepared).toEqual(independent);
      expect(independentCalls).toBe(128);
      expect(angles).toHaveBeenCalledTimes(65);
    } finally {
      angles.mockRestore();
    }
  });
});
