import { serializePressurePieces } from "../../../../src/domain/geometry/pressure-path-serialization";
import { describe, expect, it } from "vitest";
import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import {
  buildPressureOutline,
  iteratePreparedPressureOutline,
  visitPressureOutline,
  visitPreparedPressureOutline,
  type PressureOutlinePiece,
} from "../../../../src/domain/geometry/pressure-outline";
import {
  buildPressureCapsule,
  pressureArcPoint,
} from "../../../../src/domain/geometry/pressure-joins";
import { simplifyStrokeCenters } from "../../../../src/domain/geometry/stroke-simplification";
import type { StrokeCenter } from "../../../../src/domain/geometry/stroke-path";

function pieces(centers: readonly StrokeCenter[], width = 22): PressureOutlinePiece[] {
  const result: PressureOutlinePiece[] = [];
  visitPressureOutline(centers, width, (piece) => {
    result.push(piece);
    return false;
  });
  return result;
}

describe("continuous pressure outlines", () => {
  it("preserves small pressure differences without radius banding", () => {
    const values = [0.5, 0.501, 0.502].map((pressure) => pieces([{ x: 3, y: 4, pressure }])[0]!);
    expect(values.map((value) => (value.kind === "dot" ? value.radius : 0))).toEqual([
      7.425, 7.432, 7.439,
    ]);
    expect(
      new Set(
        [0.5, 0.501, 0.502].map(
          (pressure) => buildPressureOutline([{ x: 3, y: 4, pressure }], 22)[0]!.d,
        ),
      ).size,
    ).toBe(3);
  });

  it("uses common tangents to preserve both nib disks across a pressure ramp", () => {
    const [piece] = pieces(
      [
        { x: 0, y: 0, pressure: 0 },
        { x: 30, y: 0, pressure: 1 },
      ],
      8,
    );
    if (piece?.kind !== "strip") throw new Error("Expected capsule");
    const { capsule } = piece;
    expect(capsule.start.radius).toBe(1.4);
    expect(capsule.end.radius).toBe(4);
    expect(Math.hypot(capsule.left.start.x, capsule.left.start.y)).toBeCloseTo(1.4, 12);
    expect(Math.hypot(capsule.left.end.x - 30, capsule.left.end.y)).toBeCloseTo(4, 12);
    const tangent = {
      x: capsule.left.end.x - capsule.left.start.x,
      y: capsule.left.end.y - capsule.left.start.y,
    };
    expect(tangent.x * capsule.left.start.x + tangent.y * capsule.left.start.y).toBeCloseTo(0, 10);
    expect(capsule.startCap.sweep + capsule.endCap.sweep).toBeCloseTo(-2 * Math.PI, 12);
  });

  it.each([
    { x: 10, y: 0 },
    { x: -10, y: 0 },
    { x: 0, y: 10 },
    { x: 0, y: -10 },
  ])("keeps outward caps in direction %j", (end) => {
    const [piece] = pieces(
      [
        { x: 0, y: 0, pressure: 1 },
        { ...end, pressure: 1 },
      ],
      8,
    );
    if (piece?.kind !== "strip") throw new Error("Expected capsule");
    const points = [piece.capsule.startCap, piece.capsule.endCap].flatMap((arc) =>
      Array.from({ length: 25 }, (_, index) => pressureArcPoint(arc, index / 24)),
    );
    const projection = points.map((point) => (point.x * end.x + point.y * end.y) / 10);
    expect(Math.min(...projection)).toBeCloseTo(-4);
    expect(Math.max(...projection)).toBeCloseTo(14);
  });

  it("retains stationary maxima and collapses contained nib disks", () => {
    const stationary = pieces(
      [0, 1, 0].map((pressure) => ({ x: 20, y: 20, pressure })),
      8,
    );
    expect(stationary.every((piece) => piece.kind === "dot")).toBe(true);
    expect(Math.max(...stationary.map((piece) => (piece.kind === "dot" ? piece.radius : 0)))).toBe(
      4,
    );
    const [contained] = pieces(
      [
        { x: 0, y: 0, pressure: 0 },
        { x: 0.1, y: 0, pressure: 1 },
      ],
      8,
    );
    expect(contained).toEqual({ kind: "dot", center: { x: 0.1, y: 0 }, radius: 4 });
  });
});

describe("canonical pressure nibs", () => {
  it("reuses canonical nibs without changing adjacent capsules", () => {
    const centers = [
      { x: 0, y: 0, pressure: 0.1 },
      { x: 10, y: 2, pressure: 0.8 },
      { x: 20, y: -3, pressure: 0.2 },
      { x: 30, y: 4, pressure: 0.9 },
    ];
    const assembled: PressureOutlinePiece[] = [];
    visitPreparedPressureOutline(centers, 8, (piece) => {
      assembled.push(piece);
      return false;
    });
    const separate = centers.slice(1).map((end, index) => ({
      kind: "strip" as const,
      capsule: buildPressureCapsule(centers[index]!, end, 8),
      width: 8,
    }));
    expect(assembled).toEqual(separate);
    for (let index = 1; index < assembled.length; index += 1) {
      const previous = assembled[index - 1]!;
      const current = assembled[index]!;
      if (previous.kind !== "strip" || current.kind !== "strip")
        throw new Error("Expected adjacent capsules");
      expect(current.capsule.start).toBe(previous.capsule.end);
    }
  });
});

describe("prepared pressure outline iteration", () => {
  it("keeps empty and singleton prepared outlines, including singleton slice semantics", () => {
    expect([...iteratePreparedPressureOutline([], 8)]).toEqual([]);
    const center = { x: 2, y: 3, pressure: 1 };
    expect([
      ...iteratePreparedPressureOutline([center], 8, { firstBoundary: 0, lastBoundary: 0 }),
    ]).toEqual([{ kind: "dot", center, radius: 4 }]);
    expect(
      visitPreparedPressureOutline([center], 8, () => true, {
        firstBoundary: 0,
        lastBoundary: 0,
      }),
    ).toBe(true);
  });

  it("yields covered intervals and retains both neighboring slice contexts", () => {
    const centers = [
      { x: 0, y: 0, pressure: 0 },
      { x: 0, y: 0, pressure: 1 },
      { x: 10, y: 0, pressure: 1 },
    ];
    expect([
      ...iteratePreparedPressureOutline(centers, 8, { firstBoundary: 0, lastBoundary: 1 }),
    ]).toEqual([undefined]);
    const stationary = centers.map((center) => ({ ...center, x: 0 }));
    expect([
      ...iteratePreparedPressureOutline(stationary, 8, { firstBoundary: 1, lastBoundary: 2 }),
    ]).toEqual([undefined]);
    expect([...iteratePreparedPressureOutline(stationary, 8)]).toEqual([
      { kind: "dot", center: { x: 0, y: 0 }, radius: 4 },
      undefined,
    ]);
    const visited: PressureOutlinePiece[] = [];
    expect(
      visitPreparedPressureOutline(stationary, 8, (piece) => {
        visited.push(piece);
        return false;
      }),
    ).toBe(false);
    expect(visited).toEqual([{ kind: "dot", center: { x: 0, y: 0 }, radius: 4 }]);
  });

  it("stops prepared visitation and closes a cancelled iterator before the next interval", () => {
    const centers = [
      { x: 0, y: 0, pressure: 0.1 },
      { x: 10, y: 2, pressure: 0.8 },
      {
        get x(): number {
          throw new Error("Unexpected next interval");
        },
        y: -3,
        pressure: 0.2,
      },
    ];
    expect(visitPreparedPressureOutline(centers, 8, () => true)).toBe(true);
    const steps = iteratePreparedPressureOutline(centers, 8);
    const first = steps.next();
    if (first.done) throw new Error("Expected first pressure interval");
    expect(first.value?.kind).toBe("strip");
    steps.return(undefined);
    expect(steps.next().done).toBe(true);
  });
});

describe("pressure contour assembly", () => {
  it("assembles prepared sections identically across bounded live slices", () => {
    const centers = Array.from({ length: 200 }, (_, index) => ({
      x: index * 2,
      y: Math.sin(index / 12) * 8,
      pressure: (index % 20) / 20,
    }));
    const selected = simplifyStrokeCenters(centers, 22, true);
    const assembled: PressureOutlinePiece[] = [];
    for (let index = 0; index < selected.length - 1; index += 1)
      visitPreparedPressureOutline(
        selected,
        22,
        (piece) => {
          assembled.push(piece);
          return false;
        },
        { firstBoundary: index, lastBoundary: index + 1 },
      );
    expect(serializePressurePieces(assembled)).toBe(buildPressureOutline(centers, 22)[0]!.d);
  });

  it("does not partition a smooth constant-pressure curve at every sample", () => {
    const centers = Array.from({ length: 200 }, (_, index) => ({
      x: index * 2,
      y: Math.sin(index / 40) * 20,
      pressure: 0.8,
    }));
    const path = buildPressureOutline(centers, 22)[0]!.d;
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path).not.toMatch(/NaN|Infinity/);
  });
});

describe("bounded pressure input validation", () => {
  it("validates the complete input before calling the visitor", () => {
    const centers = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 10, y: 0, pressure: Number.NaN },
    ];
    let calls = 0;
    expect(() =>
      visitPressureOutline(centers, 8, () => {
        calls += 1;
        return true;
      }),
    ).toThrow(RangeError);
    expect(calls).toBe(0);
  });

  it("rejects invalid capacity, coordinates and widths", () => {
    const centers = [
      { x: 0, y: 0, pressure: 0 },
      { x: 10, y: 0, pressure: 1 },
    ];
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
  });

  it("stops at the first accepted primitive", () => {
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
