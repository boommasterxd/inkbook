import { describe, expect, it } from "vitest";

import { buildPressureOutline } from "../../../../src/domain/geometry/stroke-path";
import {
  pressureSweepHull,
  visitPressureSweep,
} from "../../../../src/domain/geometry/pressure-sweep";
import { buildPressureOutlineSlice } from "../../../../src/domain/geometry/stroke-path-slice";

describe("outward pressure-stroke caps", () => {
  it.each([
    ["right", 10, 0, "M0 4L10 4A4 4 0 0 0 10-4L0-4A4 4 0 0 0 0 4Z"],
    ["left", -10, 0, "M0-4L-10-4A4 4 0 0 0-10 4L0 4A4 4 0 0 0 0-4Z"],
    ["down", 0, 10, "M-4 0L-4 10A4 4 0 0 0 4 10L4 0A4 4 0 0 0-4 0Z"],
    ["up", 0, -10, "M4 0L4-10A4 4 0 0 0-4-10L-4 0A4 4 0 0 0 4 0Z"],
  ] as const)("extends both caps outside a stroke drawn %s", (_direction, x, y, expected) => {
    // The outline traverses the positive normal first. Sweep 0 joins its sides
    // through the exterior endpoint half-plane; sweep 1 cuts into the stroke.
    expect(
      buildPressureOutline(
        [
          { x: 0, y: 0, pressure: 1 },
          { x, y, pressure: 1 },
        ],
        8,
      ),
    ).toBe(expected);
  });

  it("uses tangent sides and the actual endpoint radii for changing pressure", () => {
    const start = { x: 0, y: 0, pressure: 0 };
    const end = { x: 10, y: 0, pressure: 1 };
    const hull = pressureSweepHull(start, end, 1.4, 4)!;
    expect(Math.hypot(hull[0].x, hull[0].y)).toBeCloseTo(1.4);
    expect(Math.hypot(hull[1].x - 10, hull[1].y)).toBeCloseTo(4);
    const tangent = { x: hull[1].x - hull[0].x, y: hull[1].y - hull[0].y };
    expect(tangent.x * hull[0].x + tangent.y * hull[0].y).toBeCloseTo(0);
    expect(buildPressureOutline([start, end], 8)).toContain("A4 4 0 1 0");
  });

  it("partitions live slices into the exact same round swept pieces", () => {
    const centers = Array.from({ length: 20 }, (_, index) => ({
      x: index * 10,
      y: 0,
      pressure: 1,
    }));
    const slices = [
      { firstBoundary: null, lastBoundary: 3 },
      { firstBoundary: 3, lastBoundary: 11 },
      { firstBoundary: 11, lastBoundary: null },
    ];
    expect(slices.map((slice) => buildPressureOutlineSlice(centers, 8, slice).d).join("")).toBe(
      buildPressureOutline(centers, 8),
    );
  });

  it("keeps every local hull winding identical through thick dense reversals", () => {
    const centers = Array.from({ length: 80 }, (_, index) => ({
      x: index % 2 === 0 ? 0 : 2,
      y: index * 0.1,
      pressure: (index % 3) / 2,
    }));
    let hulls = 0;
    visitPressureSweep(centers, 8, (start, end) => {
      const a = 4 * (0.35 + 0.65 * start.pressure);
      const b = 4 * (0.35 + 0.65 * end.pressure);
      const hull = pressureSweepHull(start, end, a, b);
      if (hull !== null) {
        const area = hull.reduce((sum, point, index) => {
          const next = hull[(index + 1) % hull.length]!;
          return sum + point.x * next.y - next.x * point.y;
        }, 0);
        expect(area).toBeLessThan(0);
        hulls += 1;
      }
      return false;
    });
    expect(hulls).toBeGreaterThan(0);
    expect(buildPressureOutline(centers, 8)).not.toMatch(/(?:NaN|Infinity)/);
  });

  it("retains a stationary pressure peak and supports bounded early exit", () => {
    const centers = [0, 1, 0].map((pressure) => ({ x: 20, y: 20, pressure }));
    let maximumPressure = 0;
    visitPressureSweep(centers, 8, (start, end) => {
      maximumPressure = Math.max(maximumPressure, start.pressure, end.pressure);
      return false;
    });
    expect(maximumPressure).toBe(0.75);
    let visits = 0;
    expect(visitPressureSweep(centers, 8, () => ++visits === 1)).toBe(true);
    expect(visits).toBe(1);
  });
});
