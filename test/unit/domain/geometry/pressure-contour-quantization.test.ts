import { describe, expect, it } from "vitest";
import { iteratePressureContourQuantization } from "../../../../src/domain/geometry/pressure-contour-quantization";
import type { PressureTriangle } from "../../../../src/domain/geometry/pressure-additions";
import type { PointV1 } from "../../../../src/domain/schema/types";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { referencePressureQuantization } from "../../../fixtures/domain/pressure-quantization-reference";

function expectReference(points: readonly PointV1[], grid: number): void {
  const closed = [...points, points[0]!];
  const expected = referencePressureQuantization(closed, grid);
  const additions: PressureTriangle[] = [];
  const actual = finishGeometrySteps(iteratePressureContourQuantization(closed, grid, additions));
  expect(actual).toEqual(expected.points);
  expect(additions).toEqual(expected.additions);
  const count = { count: 0 };
  expect(finishGeometrySteps(iteratePressureContourQuantization(closed, grid, count))).toEqual(
    actual,
  );
  expect(count.count).toBe(additions.length);
  expect(actual[actual.length - 1]).toBe(actual[0]);
}

describe("pressure contour quantization", () => {
  it("keeps candidate order at ties and original bounds at extrema", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0, y: 4 },
      { x: 1.5, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 0 },
    ];
    expectReference(points, 1);
    const additions: PressureTriangle[] = [];
    finishGeometrySteps(iteratePressureContourQuantization([...points, points[0]!], 1, additions));
    expect(additions[4]![1]).toEqual({ x: 1, y: 4 });
    expectReference(
      points.map(({ x, y }) => ({ x: x + 0.5, y: y + 0.5 })),
      1,
    );
  });

  it("keeps exact contour coordinates and expansion triangles across grids and winding", () => {
    for (const grid of [0.001, 0.01, 0.1]) {
      for (let sample = 0; sample < 64; sample += 1) {
        const points = Array.from({ length: 4 + sample }, (_, index) => {
          const angle = (-2 * Math.PI * index) / (4 + sample);
          const radius = (sample % 5 === 0 && index % 2 === 0 ? 3 : 7) + sample / 11;
          return { x: Math.cos(angle) * radius + 0.137, y: Math.sin(angle) * radius - 0.251 };
        });
        expectReference(points, grid);
        if (sample % 16 === 0) expectReference([...points].reverse(), grid);
      }
    }
  });
});
