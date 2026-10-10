import { describe, expect, it, vi } from "vitest";
import type { PointV1 } from "../../../../src/domain/schema/types";
import type {
  PressureBoundaryArc,
  PressureBoundaryLine,
} from "../../../../src/domain/geometry/pressure-joins";
import {
  intersectPressureBoundaries,
  pressureBoundaryParameter,
  pressureBoundaryPoint,
} from "../../../../src/domain/geometry/pressure-boundary-intersections";

function line(x1: number, y1: number, x2: number, y2: number): PressureBoundaryLine {
  return { kind: "line", start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

function arc(center: PointV1, radius = 1, start = 0, sweep = 2 * Math.PI): PressureBoundaryArc {
  return {
    kind: "arc",
    center,
    radius,
    sweep,
    start: { x: center.x + radius * Math.cos(start), y: center.y + radius * Math.sin(start) },
    end: {
      x: center.x + radius * Math.cos(start + sweep),
      y: center.y + radius * Math.sin(start + sweep),
    },
  };
}

const origin = { x: 0, y: 0 };

describe("pressure boundary intersections", () => {
  it("finds crossing lines and preserves operand parameter order", () => {
    const first = line(-2, -2, 2, 2);
    const second = line(-1, 1, 1, -1);
    expect(intersectPressureBoundaries(first, second)).toEqual([{ first: 0.5, second: 0.5 }]);
    expect(intersectPressureBoundaries(line(0, 0, 4, 0), line(1, -1, 1, 3))).toEqual([
      { first: 0.25, second: 0.25 },
    ]);
  });

  it("rejects parallel, disjoint, and infinite-line-only intersections", () => {
    for (const other of [line(0, 1, 1, 1), line(2, 0, 3, 0), line(2, -1, 2, 1)]) {
      expect(intersectPressureBoundaries(line(0, 0, 1, 0), other)).toEqual([]);
    }
  });

  it("returns both boundaries of collinear overlap in opposite directions", () => {
    expect(intersectPressureBoundaries(line(-4, -2, 4, -2), line(2, -2, -2, -2))).toEqual([
      { first: 0.75, second: 0 },
      { first: 0.25, second: 1 },
    ]);
  });

  it("handles shared endpoints and zero-length boundaries", () => {
    expect(intersectPressureBoundaries(line(0, 0, 1, 0), line(1, 0, 1, 1))).toEqual([
      { first: 1, second: 0 },
    ]);
    expect(intersectPressureBoundaries(line(0, 0, 0, 0), line(-1, 0, 1, 0))).toEqual([
      { first: 0, second: 0.5 },
      { first: 1, second: 0.5 },
    ]);
    expect(pressureBoundaryParameter(line(0, 0, 0, 0), { x: 1, y: 1 })).toBeUndefined();
  });

  it("retains Euclidean roundoff at endpoints and rejects diagonal box corners", () => {
    const epsilon = 32 * Number.EPSILON;
    const boundary = line(0, 0, 0, 0);
    for (const sign of [-1, 1]) {
      expect(pressureBoundaryParameter(boundary, { x: sign * epsilon, y: 0 })).toBe(0);
      expect(pressureBoundaryParameter(boundary, { x: 0, y: sign * epsilon })).toBe(0);
      expect(
        pressureBoundaryParameter(boundary, { x: sign * epsilon, y: sign * epsilon }),
      ).toBeUndefined();
      expect(pressureBoundaryParameter(boundary, { x: sign * epsilon * 2, y: 0 })).toBeUndefined();
    }
    expect(pressureBoundaryParameter(line(-1, 0, 1, 0), { x: 0, y: epsilon })).toBe(0.5);
    expect(pressureBoundaryParameter(line(-1, 0, 1, 0), { x: 0, y: epsilon * 2 })).toBeUndefined();
  });

  it("finds line-circle crossings including a full circle seam", () => {
    const hits = intersectPressureBoundaries(line(-2, 0, 2, 0), arc(origin));
    expect(hits).toContainEqual({ first: 0.25, second: 0.5 });
    expect(hits).toContainEqual({ first: 0.75, second: 0 });
    expect(hits).toContainEqual({ first: 0.75, second: 1 });
    const swapped = intersectPressureBoundaries(arc(origin), line(-2, 0, 2, 0));
    for (const hit of hits)
      expect(swapped).toContainEqual({ first: hit.second, second: hit.first });
  });

  it("preserves intersection parameters with a window-local arc-angle cache", () => {
    const circle = arc({ x: 2, y: -3 }, 4, Math.PI / 4, -1.5 * Math.PI);
    const crossing = line(-4, -3, 8, -3);
    const expected = intersectPressureBoundaries(circle, crossing);
    const cache = new WeakMap<PressureBoundaryArc, number>();
    expect(intersectPressureBoundaries(circle, crossing, cache)).toEqual(expected);
    expect(intersectPressureBoundaries(crossing, circle, cache)).toEqual(
      intersectPressureBoundaries(crossing, circle),
    );
  });

  it("finds tangency and rejects nearby disjoint lines", () => {
    expect(intersectPressureBoundaries(line(-2, 1, 2, 1), arc(origin))).toEqual([
      { first: 0.5, second: 0.25 },
    ]);
    expect(intersectPressureBoundaries(line(-2, 1.000001, 2, 1.000001), arc(origin))).toEqual([]);
    expect(intersectPressureBoundaries(line(0, 0, 0, 0), arc(origin))).toEqual([]);
  });

  it("filters circle hits against negative and major arc sweeps", () => {
    const lower = arc(origin, 1, 0, -Math.PI);
    expect(intersectPressureBoundaries(line(0, -2, 0, 2), lower)).toEqual([
      { first: 0.25, second: 0.5 },
    ]);
    const major = arc(origin, 1, 0, 1.5 * Math.PI);
    expect(pressureBoundaryParameter(major, { x: 0, y: -1 })).toBe(1);
    expect(pressureBoundaryParameter(major, { x: Math.SQRT1_2, y: -Math.SQRT1_2 })).toBeUndefined();
    expect(pressureBoundaryParameter(arc(origin, 1, 0, 0), { x: 0, y: 1 })).toBeUndefined();
  });

  it("preserves radial roundoff near an arc's coordinate extent", () => {
    const circle = arc(origin);
    const epsilon = 32 * Number.EPSILON;
    for (const sign of [-1, 1]) {
      expect(pressureBoundaryParameter(circle, { x: 0, y: sign * (1 + epsilon) })).toBeDefined();
      expect(
        pressureBoundaryParameter(circle, { x: 0, y: sign * (1 + epsilon * 2) }),
      ).toBeUndefined();
    }
  });
});

describe("pressure boundary radial tolerance", () => {
  it("retains the radial tolerance near the coordinate limit", () => {
    const center = { x: -999_999, y: -999_999 };
    const circle = arc(center, 0.35, 0.4);
    const epsilon = 32 * Number.EPSILON * Math.abs(center.x);
    expect(pressureBoundaryParameter(circle, { x: center.x, y: center.y + 0.35 })).toBeDefined();
    expect(
      pressureBoundaryParameter(circle, { x: center.x, y: center.y + 0.35 + epsilon / 2 }),
    ).toBeDefined();
    expect(
      pressureBoundaryParameter(circle, { x: center.x, y: center.y + 0.35 + epsilon * 2 }),
    ).toBeUndefined();
    expect(
      pressureBoundaryParameter(circle, { x: center.x + 0.1, y: center.y + 0.1 }),
    ).toBeUndefined();
  });
});

describe("circular pressure boundary intersections", () => {
  it("returns both circle-circle crossings on the actual boundaries", () => {
    const first = arc(origin, 2, 0.2);
    const second = arc({ x: 2, y: 0 }, 2, 0.2);
    const hits = intersectPressureBoundaries(first, second);
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      const point = pressureBoundaryPoint(first, hit.first);
      expect(point.x).toBeCloseTo(1, 12);
      expect(Math.abs(point.y)).toBeCloseTo(Math.sqrt(3), 12);
      const other = pressureBoundaryPoint(second, hit.second);
      expect(point.x).toBeCloseTo(other.x, 12);
      expect(point.y).toBeCloseTo(other.y, 12);
    }
  });

  it("handles external and internal circle tangency and disjoint containment", () => {
    const large = arc(origin, 2, 0.5);
    for (const x of [1, 3]) {
      const hits = intersectPressureBoundaries(large, arc({ x, y: 0 }, 1, 0.5));
      expect(hits).toHaveLength(1);
      expect(pressureBoundaryPoint(large, hits[0]!.first).x).toBeCloseTo(2, 12);
    }
    for (const x of [0, 0.5, 4])
      expect(intersectPressureBoundaries(large, arc({ x, y: 0 }, 1))).toEqual([]);
  });

  it("splits coincident circular overlap at endpoints for either orientation", () => {
    const first = arc(origin, 2, 0, Math.PI);
    const second = arc(origin, 2, Math.PI * 1.5, -Math.PI);
    const hits = intersectPressureBoundaries(first, second);
    expect(hits).toContainEqual({ first: 1, second: 0.5 });
    expect(hits).toContainEqual({ first: 0.5, second: 1 });
    expect(hits).toHaveLength(2);
  });

  it("retains tiny radii and large negative-coordinate tangencies", () => {
    const center = { x: -999999, y: -999999 };
    const circle = arc(center, 0.35, 0.3);
    const hits = intersectPressureBoundaries(
      line(center.x - 1, center.y + 0.35, center.x + 1, center.y + 0.35),
      circle,
    );
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const point = pressureBoundaryPoint(circle, hit.second);
      expect(point.y).toBeCloseTo(center.y + 0.35, 8);
    }
  });
});

describe("pressure arc metadata reuse", () => {
  it("reuses arc angles for midpoint and clipped endpoint generation without rounding changes", () => {
    const boundary = arc({ x: -999_999, y: 999_999 }, 0.35, 0.4, -Math.PI);
    const fractions = [0, 1, ...Array.from({ length: 64 }, (_, index) => (index + 1) / 65)];
    const expected = fractions.map((fraction) => pressureBoundaryPoint(boundary, fraction));
    const angles = vi.spyOn(Math, "atan2");
    try {
      const cache = new WeakMap<PressureBoundaryArc, number>();
      expect(fractions.map((fraction) => pressureBoundaryPoint(boundary, fraction, cache))).toEqual(
        expected,
      );
      expect(angles).toHaveBeenCalledTimes(1);
      expect(pressureBoundaryPoint(boundary, 0, cache)).toBe(boundary.start);
      expect(pressureBoundaryPoint(boundary, 1, cache)).toBe(boundary.end);
    } finally {
      angles.mockRestore();
    }
  });
});
