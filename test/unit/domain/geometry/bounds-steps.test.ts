import { describe, expect, it, vi } from "vitest";
import {
  calculateElementBounds,
  calculateElementBoundsSteps,
  effectiveStrokeWidth,
} from "../../../../src/domain/geometry/bounds";
import { boundsFromPoints, expandBounds } from "../../../../src/domain/geometry/primitives";
import { transformedStrokeCenters } from "../../../../src/domain/geometry/stroke-path";
import * as strokePosition from "../../../../src/domain/geometry/stroke-position";
import {
  arrow,
  coordinateSystem,
  line,
  rectangle,
  straightHighlighter,
  stroke,
  table,
} from "../schema/fixtures";

const pointSets = [1, 2, 3, 256, 257, 4097].map((count) =>
  Array.from({ length: count }, (_, index) => [
    index * 0.125 - 17,
    (index % 13) * 0.3 - 4,
    (index % 5) / 4,
  ]).flat(),
);
const positions = [
  { rotation: 0 },
  { rotation: 0, offset: { x: 71.123, y: -93.987 } },
  { rotation: 37, offset: { x: 71.123, y: -93.987 } },
  { rotation: 90 },
];

describe("resumable element bounds", () => {
  it.each(positions)("preserves smoothed bounds at $rotation degrees", (position) => {
    for (const points of pointSets) {
      for (const tool of ["pen", "highlighter"] as const) {
        const element = { ...stroke(1, tool), ...position, points };
        const local = strokePosition.strokeLocalGeometry(element);
        const expectedLocal = expandBounds(
          boundsFromPoints(transformedStrokeCenters(local)),
          effectiveStrokeWidth(element) / 2,
        );
        const x = element.offset?.x ?? 0;
        const y = element.offset?.y ?? 0;
        const expected = {
          minX: expectedLocal.minX + x,
          minY: expectedLocal.minY + y,
          maxX: expectedLocal.maxX + x,
          maxY: expectedLocal.maxY + y,
        };
        expect(calculateElementBounds(element)).toEqual(expected);
        for (const batch of [1, 256, Infinity]) {
          const steps = calculateElementBoundsSteps(element, batch);
          let result = steps.next();
          while (!result.done) result = steps.next();
          expect(result.value).toEqual(expected);
        }
      }
    }
  });

  it("bounds sample transforms inside a single long stroke and stops after cancellation", () => {
    const element = { ...stroke(), points: pointSets[pointSets.length - 1]! };
    const transform = vi.spyOn(strokePosition, "strokeWorldPoint");
    try {
      const steps = calculateElementBoundsSteps(element);
      let previous = 0;
      let result = steps.next();
      while (!result.done) {
        expect(transform.mock.calls.length - previous).toBe(256);
        previous = transform.mock.calls.length;
        result = steps.next();
      }
      expect(transform.mock.calls.length - previous).toBe(1);
      expect(transform).toHaveBeenCalledTimes(element.points.length / 3);
      expect(result.value).toEqual(calculateElementBounds(element));

      const cancelled = calculateElementBoundsSteps(element, 2);
      expect(cancelled.next().done).toBe(false);
      const before = transform.mock.calls.length;
      cancelled.return(result.value);
      expect(cancelled.next().done).toBe(true);
      expect(transform).toHaveBeenCalledTimes(before);
    } finally {
      transform.mockRestore();
    }
  });

  it("keeps small shape leaves indivisible", () => {
    for (const element of [
      arrow(),
      coordinateSystem(),
      line(),
      rectangle(),
      { ...rectangle(), kind: "triangle" as const },
      straightHighlighter(),
      table(),
    ]) {
      expect(calculateElementBoundsSteps(element, 1).next()).toEqual({
        done: true,
        value: calculateElementBounds(element),
      });
    }
  });

  it.each([0, -1, 1.5, NaN, -Infinity])("rejects invalid batch size %s", (batch) => {
    expect(() => calculateElementBoundsSteps(stroke(), batch).next()).toThrow(RangeError);
  });
});
