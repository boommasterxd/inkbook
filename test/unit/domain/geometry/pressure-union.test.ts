import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { describe, expect, it } from "vitest";
import { iteratePressureUnion } from "../../../../src/domain/geometry/pressure-union";
import {
  buildPressureCapsule,
  type PressureDisk,
  type PressureCenter,
} from "../../../../src/domain/geometry/pressure-joins";
import {
  pressureBoundaryPoint,
  type PressureBoundarySegment,
} from "../../../../src/domain/geometry/pressure-boundary-intersections";
import type { PointV1 } from "../../../../src/domain/schema/types";
import { polygonWinding } from "../../../fixtures/domain/svg-path-fill";

function sample(contour: readonly PressureBoundarySegment[]) {
  return contour.flatMap((edge) => {
    const count = edge.kind === "line" ? 1 : Math.ceil(Math.abs(edge.sweep) / (Math.PI / 512));
    return Array.from({ length: count }, (_, index) => pressureBoundaryPoint(edge, index / count));
  });
}

function disk(x: number, y: number, radius: number): PressureDisk {
  return { kind: "dot", center: { x, y }, radius };
}

function unionFixture(centers: readonly PressureCenter[]) {
  const shapes = centers
    .slice(1)
    .map((last, index) => buildPressureCapsule(centers[index]!, last, 22));
  const result = finishGeometrySteps(iteratePressureUnion(shapes));
  expect(result.usedFallback).toBe(false);
  return {
    result,
    actual: result.contours.map(sample),
    independent: shapes.flatMap((shape) =>
      finishGeometrySteps(iteratePressureUnion([shape])).contours.map(sample),
    ),
  };
}

function expectGridUnion(
  actual: readonly PointV1[][],
  independent: readonly PointV1[][],
  xRange: readonly [number, number, number],
  yRange: readonly [number, number, number],
): void {
  for (let x = xRange[0]; x < xRange[1]; x += xRange[2]) {
    for (let y = yRange[0]; y < yRange[1]; y += yRange[2]) {
      const point = { x, y };
      expect(actual.reduce((sum, contour) => sum + polygonWinding(contour, point), 0) !== 0).toBe(
        independent.some((contour) => polygonWinding(contour, point) !== 0),
      );
    }
  }
}

describe("bounded pressure capsule union", () => {
  it.each([
    [
      "shared nib",
      [
        [0, 0],
        [10, 1],
        [20, 3],
      ],
    ],
    [
      "reversal",
      [
        [0, 0],
        [10, 0],
        [0, 0],
        [-10, 0],
      ],
    ],
    [
      "short thick corner",
      [
        [0, 0],
        [0.5, -1],
        [3, -1],
      ],
    ],
    [
      "hole",
      [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
        [0, 0],
      ],
    ],
    [
      "crossing",
      [
        [-20, -20],
        [20, 20],
        [-20, 20],
        [20, -20],
      ],
    ],
  ] as const)("preserves filled union and holes for %s", (_label, positions) => {
    const centers = positions.map(([x, y]) => ({ x, y, pressure: 1 }));
    const { result, actual, independent } = unionFixture(centers);
    expectGridUnion(actual, independent, [-32.173, 53, 2.137], [-32.391, 53, 2.193]);
    if (_label === "hole") expect(result.contours).toHaveLength(2);
  });
});

describe("pressure union degeneracies", () => {
  it("keeps one deterministic boundary for duplicate and contained disks", () => {
    const result = finishGeometrySteps(
      iteratePressureUnion([disk(-10, -20, 5), disk(-10, -20, 5), disk(-9, -20, 1)]),
    );
    expect(result.usedFallback).toBe(false);
    expect(result.contours).toHaveLength(1);
    expect(result.contours[0]).toHaveLength(1);
    expect(result.contours[0]![0]).toMatchObject({ kind: "arc", sweep: -2 * Math.PI });
  });

  it("retains tangent disks and disconnected components near the coordinate limit", () => {
    const result = finishGeometrySteps(
      iteratePressureUnion([
        disk(999_980, -999_980, 5),
        disk(999_990, -999_980, 5),
        disk(999_980, -999_960, 2),
      ]),
    );
    expect(result.usedFallback).toBe(false);
    const contours = result.contours.map(sample);
    for (const point of [
      { x: 999_980, y: -999_980 },
      { x: 999_990, y: -999_980 },
      { x: 999_980, y: -999_960 },
    ]) {
      expect(contours.reduce((sum, contour) => sum + polygonWinding(contour, point), 0)).toBe(-1);
    }
  });

  it("preserves the hole enclosed by four tangent disks across all source orders", () => {
    const shapes = [disk(-5, -5, 5), disk(5, -5, 5), disk(5, 5, 5), disk(-5, 5, 5)];
    for (let offset = 0; offset < shapes.length; offset += 1) {
      const ordered = [...shapes.slice(offset), ...shapes.slice(0, offset)];
      const result = finishGeometrySteps(iteratePressureUnion(ordered));
      expect(result.usedFallback).toBe(false);
      const contours = result.contours.map(sample);
      for (let x = -11.137; x < 12; x += 0.739) {
        for (let y = -11.231; y < 12; y += 0.713) {
          const point = { x, y };
          const filled =
            contours.reduce((sum, contour) => sum + polygonWinding(contour, point), 0) !== 0;
          expect(filled).toBe(
            shapes.some(
              (shape) => Math.hypot(x - shape.center.x, y - shape.center.y) < shape.radius,
            ),
          );
        }
      }
      expect(
        contours.reduce((sum, contour) => sum + polygonWinding(contour, { x: 0, y: 0 }), 0),
      ).toBe(0);
    }
  });

  it("handles empty windows and rejects unbounded inputs", () => {
    expect(finishGeometrySteps(iteratePressureUnion([]))).toMatchObject({
      contours: [],
      usedFallback: false,
    });
    expect(() =>
      finishGeometrySteps(iteratePressureUnion(Array.from({ length: 65 }, () => disk(0, 0, 1)))),
    ).toThrow(RangeError);
  });
});

function seededPressureTurn(): PressureCenter[] {
  let seed = 413;
  const random = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  let centers: PressureCenter[] = [];
  for (let trial = 0; trial <= 283; trial += 1) {
    centers = [];
    let x = 0;
    let y = 0;
    let angle = 0;
    for (let index = 0; index < 20; index += 1) {
      angle += (random() - 0.5) * Math.PI;
      x += Math.cos(angle) * (random() * 3 + 0.1);
      y += Math.sin(angle) * (random() * 3 + 0.1);
      centers.push({ x, y, pressure: random() });
    }
  }
  return centers;
}

describe("pressure union cancellation regression", () => {
  it("retains the seeded pressure turn with contained nibs", () => {
    const centers = seededPressureTurn();
    const { actual, independent } = unionFixture(centers);
    expectGridUnion(actual, independent, [-10.17, 30, 1.13], [-20.31, 15, 1.17]);
    expect(
      actual.reduce((sum, contour) => sum + polygonWinding(contour, { x: 5.34, y: 7.23 }), 0),
    ).toBe(-1);
  });
});
