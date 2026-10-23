import { describe, expect, it } from "vitest";

import { canonicalPoint, rotatePointClockwise } from "../../../../../src/domain/geometry/public";
import { MAX_STROKE_POINTS, type StrokeElementV1 } from "../../../../../src/domain/schema/public";
import { SelectionScaleGesture } from "../../../../../src/editor/selection/transform/selection-scale";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import { stroke } from "../../../domain/schema/fixtures";

const anchor = { x: -25, y: 40 };
const pointer = { x: 500, y: 750 };
const factors = { x: 1.25, y: 0.75 };
const cases = [false, true].flatMap((typed) =>
  [1, MAX_STROKE_POINTS].flatMap((count) =>
    [-179.999, -90.002, -37, 0.002, 37, 89.998, 90.002, 179.999].map((rotation) => ({
      typed,
      count,
      rotation,
    })),
  ),
);

describe("arbitrary-frame stroke scaling", () => {
  it.each(cases)(
    "preserves exact coordinates and owned storage: typed=$typed count=$count rotation=$rotation",
    ({ typed, count, rotation }) => {
      const source = rotatedStroke(count, rotation, typed);
      const original = source.points.slice();
      const gesture = createGesture(source);
      const expected = scaleElement(referenceFlatten(source), anchor, factors);
      const actual = gesture.materializeOne(source, pointer, false, factors);
      expect(actual).toEqual(expected);
      if (actual.kind !== "stroke") throw new Error("Expected a stroke replacement.");
      expect(actual.points instanceof Float64Array).toBe(typed);
      expect(actual.points).not.toBe(source.points);
      expect(source.points).toEqual(original);
      expect(source.rotation).toBe(rotation);
      let pressureFailure: {
        actual: number | undefined;
        expected: number | undefined;
        sampleIndex: number;
      } | null = null;
      for (let index = 2; index < actual.points.length; index += 3) {
        const pressure = actual.points[index];
        const expectedPressure = original[index];
        if (!Object.is(pressure, expectedPressure))
          pressureFailure ??= {
            actual: pressure,
            expected: expectedPressure,
            sampleIndex: (index - 2) / 3,
          };
      }
      expect(pressureFailure).toBeNull();
      if (actual.points instanceof Float64Array) {
        actual.points[0] = 123;
        expect(source.points).toEqual(original);
      }
    },
  );

  it.each([-125, 250])("resizes a previously moved rotated stroke with offset %s", (offset) => {
    const source = { ...rotatedStroke(2, 37, true), offset: { x: offset, y: -offset } };
    const gesture = createGesture(source);
    const expected = scaleElement(referenceFlatten(source), anchor, factors);
    expect(gesture.materializeOne(source, pointer, false, factors)).toEqual(expected);
  });

  it("retains the original samples when a replacement calculation rejects a non-finite value", () => {
    const source = rotatedStroke(2, 37, false);
    const gesture = createGesture(source);
    const malformed = { ...source, points: [Infinity, 0, 0.5] };
    const original = malformed.points.slice();
    expect(() => gesture.materializeOne(malformed, pointer, false, factors)).toThrow(RangeError);
    expect(malformed.points).toEqual(original);
  });

  it("materializes and stabilizes a group identically to its pre-flattened equivalent", () => {
    const source = { ...stroke(), rotation: 37 };
    const other = { ...stroke(2), rotation: -23 };
    const elements = [source, other];
    const gesture = new SelectionScaleGesture(
      { anchor, kind: "scale", position: "bottom-right", rotation: 0 },
      elements,
      pointer,
    );
    const target = { x: 800, y: 950 };
    const resolvedFactors = gesture.factorsAt(target, false);
    const expected = gesture.stabilizeAnchor(
      elements.map((element) => scaleElement(referenceFlatten(element), anchor, resolvedFactors)),
    );
    expect(gesture.materialize(target, false)).toEqual(expected);
  });
});

function rotatedStroke(count: number, rotation: number, typed: boolean): StrokeElementV1 {
  const values = Array.from({ length: count * 3 }, (_, index) => {
    if (index % 3 === 2) return (index % 11) / 10;
    return index % 2 === 0 ? -900_000 + index * 0.001 : 900_000 - index * 0.003;
  });
  const points = typed ? new Float64Array(values) : Object.freeze(values);
  return {
    ...stroke(),
    pivot: { x: 0.001, y: -0.001 },
    points: points as unknown as StrokeElementV1["points"],
    rotation,
  };
}

function createGesture(source: StrokeElementV1): SelectionScaleGesture {
  return new SelectionScaleGesture(
    { anchor, kind: "scale", position: "bottom-right", rotation: 0 },
    [source, stroke(2)],
    pointer,
  );
}

// Preserve the previous per-coordinate rotation as an independent regression oracle.
function referenceFlatten(element: StrokeElementV1): StrokeElementV1 {
  const rotate = (x: number, y: number) =>
    canonicalPoint(
      rotatePointClockwise(
        {
          x: x + (element.offset?.x ?? 0),
          y: y + (element.offset?.y ?? 0),
        },
        element.pivot,
        element.rotation,
      ),
    );
  const { offset: _offset, ...shape } = element;
  return {
    ...shape,
    points: element.points.map((value, index, points) => {
      if (index % 3 === 2) return value;
      return index % 3 === 1
        ? rotate(points[index - 1]!, value).y
        : rotate(value, points[index + 1]!).x;
    }),
    rotation: 0,
  };
}
