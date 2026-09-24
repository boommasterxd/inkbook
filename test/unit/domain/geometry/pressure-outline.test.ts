import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import { describe, expect, it } from "vitest";

import {
  buildPressureOutline,
  visitPressureOutline,
  type PressureOutlinePiece,
} from "../../../../src/domain/geometry/pressure-outline";
import { quadraticPoint } from "../../../../src/domain/geometry/primitives";
import type { StrokeCenter } from "../../../../src/domain/geometry/stroke-path";

function pieces(centers: readonly StrokeCenter[], width = 22): PressureOutlinePiece[] {
  const result: PressureOutlinePiece[] = [];
  visitPressureOutline(centers, width, (piece) => {
    result.push(piece);
    return false;
  });
  return result;
}

function sidePoint(
  side: readonly [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
  t: number,
) {
  return quadraticPoint(side[0], side[1], side[2], t);
}

function contour(piece: Extract<PressureOutlinePiece, { kind: "strip" }>) {
  const points = Array.from({ length: 25 }, (_, index) => sidePoint(piece.left, index / 24));
  const dx = piece.end.x - piece.start.x;
  const dy = piece.end.y - piece.start.y;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const cap = (center: { x: number; y: number }, radius: number, direction: number) => {
    for (let index = 1; index <= 24; index += 1) {
      const angle = (Math.PI * index) / 24;
      points.push({
        x: center.x + direction * radius * (-uy * Math.cos(angle) + ux * Math.sin(angle)),
        y: center.y + direction * radius * (ux * Math.cos(angle) + uy * Math.sin(angle)),
      });
    }
  };
  if (piece.endCap) cap(piece.end, piece.endRadius, 1);
  else points.push(piece.right[2]);
  for (let index = 23; index >= 0; index -= 1) points.push(sidePoint(piece.right, index / 24));
  if (piece.startCap) cap(piece.start, piece.startRadius, -1);
  else points.push(piece.left[0]);
  return points;
}

describe("continuous pressure outlines", () => {
  it("retains pressure changes much smaller than a former quantization level", () => {
    const widths = [0.5, 0.501, 0.502].map((pressure) => {
      const [piece] = pieces([{ x: 3, y: 4, pressure }]);
      if (piece === undefined || piece.kind !== "dot") throw new Error("Expected a pressure dot");
      return piece.radius;
    });
    expect(widths).toEqual([7.425, 7.432, 7.439]);
    expect(
      new Set(
        [0.5, 0.501, 0.502].map(
          (pressure) => buildPressureOutline([{ x: 3, y: 4, pressure }], 22)[0]!.d,
        ),
      ).size,
    ).toBe(3);
  });

  it("interpolates radius continuously across a pressure ramp with one six-command ribbon", () => {
    const centers = [
      { x: 0, y: 0, pressure: 0 },
      { x: 30, y: 0, pressure: 1 },
    ];
    const [piece] = pieces(centers, 8);
    if (piece === undefined || piece.kind !== "strip") throw new Error("Expected a pressure strip");
    expect(piece.left).toEqual([
      { x: 0, y: 1.4 },
      { x: 15, y: 2.7 },
      { x: 30, y: 4 },
    ]);
    expect(piece.right).toEqual([
      { x: 0, y: -1.4 },
      { x: 15, y: -2.7 },
      { x: 30, y: -4 },
    ]);
    const paths = buildPressureOutline(centers, 8);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.paint).toBe("fill");
    expect(paths[0]!.d.toUpperCase().match(/[A-Z]/g)).toEqual(["M", "Q", "A", "Q", "A", "Z"]);
  });

  it("builds outward round caps in every direction", () => {
    for (const end of [
      { x: 10, y: 0 },
      { x: -10, y: 0 },
      { x: 0, y: 10 },
      { x: 0, y: -10 },
    ]) {
      const [piece] = pieces(
        [
          { x: 0, y: 0, pressure: 1 },
          { ...end, pressure: 1 },
        ],
        8,
      );
      if (piece === undefined || piece.kind !== "strip")
        throw new Error("Expected a pressure strip");
      expect(piece.startRadius).toBe(4);
      expect(piece.endRadius).toBe(4);
      const points = contour(piece);
      const projections = points.map((point) => (point.x * end.x + point.y * end.y) / 10);
      expect(Math.min(...projections)).toBeCloseTo(-4);
      expect(Math.max(...projections)).toBeCloseTo(14);
    }
  });
});

describe("pressure outline overlap and precision", () => {
  it("keeps every dense reversal ribbon monotone with identical winding", () => {
    const centers = Array.from({ length: 80 }, (_, index) => ({
      x: index % 2 ? 2 : 0,
      y: index * 0.1,
      pressure: (index % 3) / 2,
    }));
    const result = pieces(centers);
    expect(result.length).toBeLessThanOrEqual(centers.length * 4);
    for (const piece of result) {
      if (piece.kind === "dot") continue;
      const points = contour(piece);
      const area = points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length]!;
        return sum + point.x * next.y - next.x * point.y;
      }, 0);
      expect(area).toBeLessThan(0);
      const dx = piece.end.x - piece.start.x;
      const dy = piece.end.y - piece.start.y;
      let previous = -Infinity;
      for (let index = 0; index <= 24; index += 1) {
        const left = sidePoint(piece.left, index / 24);
        const right = sidePoint(piece.right, index / 24);
        const center = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
        const projection = center.x * dx + center.y * dy;
        expect(projection).toBeGreaterThanOrEqual(previous - 0.002);
        expect((left.x - right.x) * -dy + (left.y - right.y) * dx).toBeGreaterThan(0);
        previous = projection;
      }
    }
    expect(buildPressureOutline(centers, 22)[0]!.d).not.toMatch(/NaN|Infinity/);
  });

  it("retains stationary pressure maxima and exactly four commands for dots", () => {
    expect(buildPressureOutline([{ x: 3, y: 4, pressure: 1 }], 8)).toEqual([
      { d: "M-1 4A4 4 0 0 0 7 4A4 4 0 0 0-1 4Z", paint: "fill" },
    ]);
    const stationary = pieces(
      [0, 1, 0].map((pressure) => ({ x: 20, y: 20, pressure })),
      8,
    );
    expect(stationary.every((piece) => piece.kind === "dot")).toBe(true);
    expect(Math.max(...stationary.map((piece) => (piece.kind === "dot" ? piece.radius : 0)))).toBe(
      3.35,
    );
  });

  it("keeps all numerical side coordinates and radii at canonical precision", () => {
    const result = pieces([
      { x: 0.1234, y: 1.2345, pressure: 0.1234 },
      { x: 11.4567, y: 17.2345, pressure: 0.8765 },
    ]);
    for (const piece of result) {
      const values =
        piece.kind === "dot"
          ? [piece.center.x, piece.center.y, piece.radius]
          : [...piece.left, ...piece.right]
              .flatMap((point) => [point.x, point.y])
              .concat(piece.startRadius, piece.endRadius);
      for (const value of values) expect(Number(value.toFixed(3))).toBe(value);
    }
  });
});

describe("continuous pressure run packing", () => {
  it("removes internal caps from matching pressure sections with bounded canonical partitions", () => {
    const centers = Array.from({ length: 40 }, (_, index) => ({
      x: index * 10,
      y: 0,
      pressure: (index % 8) / 7,
    }));
    const result = pieces(centers);
    const strips = result.filter((piece) => piece.kind === "strip");
    expect(strips.some((piece) => !piece.startCap && !piece.endCap)).toBe(true);
    let runLength = 0;
    for (const piece of strips) {
      if (piece.startCap) runLength = 0;
      runLength += 1;
      expect(runLength).toBeLessThanOrEqual(32);
    }
    const d = buildPressureOutline(centers, 22)[0]!.d;
    expect(d.match(/A/gi)).toHaveLength(strips.filter((piece) => piece.endCap).length * 2);
    expect(d.match(/[A-Z]/gi)!.length).toBeLessThan(strips.length * 6);
    const slices = [
      { firstBoundary: null, lastBoundary: 11 },
      { firstBoundary: 11, lastBoundary: 19 },
      { firstBoundary: 19, lastBoundary: null },
    ];
    expect(slices.map((slice) => buildPressureOutline(centers, 22, slice)[0]!.d).join("")).toBe(d);
  });

  it("collapses subpixel chords that round to one canonical point into valid dots", () => {
    const result = pieces([
      { x: 0, y: 0, pressure: 0.5 },
      { x: 0.0001, y: 0, pressure: 0.75 },
    ]);
    expect(result).toEqual([{ kind: "dot", center: { x: 0, y: 0 }, radius: 9.213 }]);
  });
});

describe("bounded pressure slice validation", () => {
  it("reads only consumed centers and rejects invalid values in that slice", () => {
    const centers = Array.from({ length: MAX_STROKE_POINTS }, (_, index) => ({
      x: index,
      y: 0,
      pressure: 0.5,
    }));
    const bounded = new Proxy(centers, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key) && (Number(key) < 63 || Number(key) > 128))
          throw new Error("Outside the bounded curve slice");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const slice = { firstBoundary: 63, lastBoundary: 127 };
    expect(() => visitPressureOutline(bounded, 8, () => false, slice)).not.toThrow();
    centers[128]!.pressure = Number.NaN;
    expect(() => visitPressureOutline(bounded, 8, () => false, slice)).toThrow(RangeError);
  });

  it("rejects invalid limits, widths, centers and slice boundaries", () => {
    const centers = [
      { x: 0, y: 0, pressure: 0 },
      { x: 10, y: 0, pressure: 1 },
    ];
    for (const slice of [
      { firstBoundary: -1, lastBoundary: null },
      { firstBoundary: 0.5, lastBoundary: null },
      { firstBoundary: null, lastBoundary: 1 },
      { firstBoundary: 0, lastBoundary: 0 },
    ]) {
      expect(() => visitPressureOutline(centers, 8, () => false, slice)).toThrow(RangeError);
    }
    for (const width of [0, -1, Number.NaN, Infinity])
      expect(() => buildPressureOutline(centers, width)).toThrow(RangeError);
    for (const key of ["x", "y", "pressure"] as const)
      expect(() => buildPressureOutline([{ ...centers[0]!, [key]: Number.NaN }], 8)).toThrow(
        RangeError,
      );
    expect(() => buildPressureOutline([], 8)).toThrow(RangeError);
    expect(() =>
      buildPressureOutline(
        Array.from({ length: MAX_STROKE_POINTS + 1 }, () => centers[0]!),
        8,
      ),
    ).toThrow(RangeError);
    expect(
      buildPressureOutline(centers, 8, { firstBoundary: 0, lastBoundary: null })[0]!.d,
    ).toMatch(/^M5 /);
  });

  it("supports early exit without visiting remaining ribbons", () => {
    let calls = 0;
    expect(
      visitPressureOutline(
        [
          { x: 0, y: 0, pressure: 0 },
          { x: 10, y: 0, pressure: 1 },
        ],
        8,
        () => {
          calls += 1;
          return true;
        },
      ),
    ).toBe(true);
    expect(calls).toBe(1);
  });
});
