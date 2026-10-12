import { describe, expect, it } from "vitest";
import { iteratePressureCollinearPruning } from "../../../../src/domain/geometry/pressure-collinear-pruning";
import type { PointV1 } from "../../../../src/domain/schema/types";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import {
  pressureCollinearBox,
  referencePressureCollinearPruning,
} from "../../../fixtures/domain/pressure-quantization-reference";

function expectReference(points: PointV1[]): void {
  const expected = [...points];
  const actual = [...points];
  referencePressureCollinearPruning(expected);
  finishGeometrySteps(iteratePressureCollinearPruning(actual));
  expect(actual).toEqual(expected);
  actual.forEach((point, index) => expect(point).toBe(expected[index]));
}

describe("pressure collinear pruning", () => {
  it("preserves small rings, reversals, duplicated points, and cyclic-seam removals", () => {
    const cases = [
      [],
      [{ x: 0, y: 0 }],
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      pressureCollinearBox(96),
      Array.from({ length: 128 }, (_, index) => ({ x: index % 2, y: 0 })),
      Array.from({ length: 64 }, () => ({ x: 2, y: 3 })),
      Array.from({ length: 64 }, (_, index) => ({ x: index, y: 0 })),
      [
        { x: 2, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 2 },
        { x: 4, y: 2 },
        { x: 4, y: 0 },
      ],
    ];
    for (const points of cases) expectReference(points);
    const box = pressureCollinearBox(96);
    for (let seam = 0; seam < box.length; seam += 1)
      expectReference([...box.slice(seam), ...box.slice(0, seam)]);
  });

  it("preserves near-collinear floating-point decisions and dirty-neighbor ordering", () => {
    let seed = 0x1badb002;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let sample = 0; sample < 256; sample += 1) {
      const magnitude = [1e-8, 1, 1e8][sample % 3]!;
      const points = Array.from({ length: 4 + (sample % 61) }, () => ({
        x: (Math.floor(random() * 8) - 4) * magnitude,
        y: (Math.floor(random() * 4) - 2) * magnitude,
      }));
      if (sample % 4 === 0)
        points.forEach((point) => {
          point.y = point.x * 3 + Number.EPSILON * magnitude;
        });
      expectReference(points);
    }
    expectReference([
      { x: 1, y: 1 },
      { x: 2, y: 2 + Number.EPSILON },
      { x: 3, y: 3 + 4 * Number.EPSILON },
      { x: 4, y: 4 },
      { x: 0, y: 5 },
    ]);
  });

  it("rechecks successor zero after removing the final original vertex near roundoff", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: -100 },
      { x: -100, y: -100 },
      { x: -1, y: -1 + 1e-13 },
    ];
    const actual = [...points];
    finishGeometrySteps(iteratePressureCollinearPruning(actual));
    expect(actual).toEqual([points[1], points[2], points[3]]);
    for (let seam = 1; seam < points.length; seam += 1)
      expectReference([...points.slice(seam), ...points.slice(0, seam)]);
  });
});
