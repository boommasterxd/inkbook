import { describe, expect, it, vi } from "vitest";
import * as intersections from "../../../src/domain/geometry/pressure-boundary-intersections";
import { pressureArcPoint } from "../../../src/domain/geometry/pressure-joins";
import { visitPreparedPressureOutline } from "../../../src/domain/geometry/pressure-outline";
import * as pressureRadius from "../../../src/domain/geometry/pressure-radius";
import {
  iteratePressureUnion,
  pressureShapeBoundary,
} from "../../../src/domain/geometry/pressure-union";

describe("bounded pressure preparation work", () => {
  it("groups exact-union probes without widening a bounded contour step", () => {
    const shapes = Array.from({ length: 64 }, (_, index) => ({
      kind: "dot" as const,
      center: { x: index % 8, y: Math.floor(index / 8) },
      radius: 3,
    }));
    const probes = vi.spyOn(intersections, "intersectPressureBoundaries");
    try {
      const job = iteratePressureUnion(shapes);
      let resumptions = 0;
      let step;
      do {
        const previous = probes.mock.calls.length;
        step = job.next();
        resumptions += 1;
        // One disk boundary can probe two edges for each of the other 63 disks.
        expect(probes.mock.calls.length - previous).toBeLessThanOrEqual(126);
      } while (!step.done);
      expect(probes.mock.calls.length).toBe(step.value.work.intersectionTests);
      expect(probes.mock.calls.length).toBeGreaterThan(500);
      // Reject the former per-source and per-interval generator polling cadence.
      expect(resumptions).toBeLessThanOrEqual(
        128 +
          Math.ceil(step.value.work.intervalTests / 16) +
          2 * Math.ceil(step.value.work.visibleFragments / 16) +
          step.value.contours.length +
          1,
      );
      expect(resumptions).toBeLessThanOrEqual(512);
    } finally {
      probes.mockRestore();
    }
  });

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
