import { describe, expect, it } from "vitest";

import type { InkElementV1, StrokeElementV1 } from "../../../../../src/domain/schema/public";
import {
  classifyReplacement,
  classifyReplacementSteps,
  elementsEqual,
  elementsEqualSteps,
} from "../../../../../src/domain/store/records/element-comparison";

import { connectedLine, coordinateSystem, highlighter, rectangle } from "../fixtures";

function drain<T>(steps: Generator<void, T>): T {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

function runtimeSamples(values: number[] | Float64Array): StrokeElementV1["points"] {
  return values as unknown as StrokeElementV1["points"];
}

describe("element comparison steps", () => {
  it("preserves exact equality and replacement domains across element fields", () => {
    const stroke = highlighter();
    const line = connectedLine();
    const shape = rectangle();
    const coordinate = coordinateSystem();
    const cases: { before: InkElementV1; after: InkElementV1; expected: string[] }[] = [
      { before: stroke, after: structuredClone(stroke), expected: [] },
      {
        before: stroke,
        after: { ...stroke, style: { ...stroke.style, opacity: 0.2 } },
        expected: ["paint"],
      },
      {
        before: stroke,
        after: { ...stroke, points: [100, 300, 0.5, 201, 300, 0.5] },
        expected: ["geometry"],
      },
      { before: stroke, after: { ...stroke, offset: { x: 2, y: 0 } }, expected: ["geometry"] },
      { before: line, after: { ...line, startConnection: null }, expected: ["connection"] },
      { before: line, after: { ...line, start: { x: 999, y: 1 } }, expected: ["geometry"] },
      { before: shape, after: { ...shape, width: 500 }, expected: ["geometry"] },
      {
        before: coordinate,
        after: {
          ...coordinate,
          dimension: "3d",
          axes: [
            { x: 1, y: 2 },
            { x: 300, y: 100 },
            { x: 200, y: 400 },
          ],
        },
        expected: ["geometry"],
      },
      { before: shape, after: { ...shape, createdAt: 2 }, expected: [] },
    ];
    for (const [index, { before, after, expected }] of cases.entries()) {
      expect(drain(classifyReplacementSteps(before, after, 1))).toEqual(expected);
      expect(classifyReplacement(before, after)).toEqual(expected);
      expect(drain(elementsEqualSteps(before, after, 1))).toBe(elementsEqual(before, after));
      expect(elementsEqual(before, after)).toBe(index === 0);
    }
  });
});

describe("bounded stroke comparisons", () => {
  it.each(["ordinary", "typed", "mixed"])(
    "bounds long stroke sample reads with %s storage",
    (storage) => {
      const values = Array.from({ length: 30_000 }, (_, index) => (index % 3 === 2 ? 0.5 : index));
      const leftValues = storage !== "ordinary" ? new Float64Array(values) : values;
      const rightValues = storage === "typed" ? new Float64Array(values) : [...values];
      let reads = 0;
      const counted = <T extends number[] | Float64Array>(source: T): T =>
        new Proxy(source, {
          get(target, key) {
            if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
            return Reflect.get(target, key, target) as unknown;
          },
        });
      const left: StrokeElementV1 = {
        ...highlighter(),
        points: runtimeSamples(counted(leftValues)),
      };
      const right: StrokeElementV1 = {
        ...highlighter(),
        points: runtimeSamples(counted(rightValues)),
      };
      for (const steps of [
        elementsEqualSteps(left, right),
        classifyReplacementSteps(left, right),
      ]) {
        let result;
        const startReads = reads;
        do {
          const previousReads = reads;
          result = steps.next();
          expect(reads - previousReads).toBeLessThanOrEqual(512);
        } while (!result.done);
        expect(result.value).toEqual(typeof result.value === "boolean" ? true : []);
        expect(reads - startReads).toBe(values.length * 2);
      }
      const stopped = elementsEqualSteps(left, right);
      stopped.next();
      const stoppedReads = reads;
      stopped.return(false);
      stopped.next();
      expect(reads).toBe(stoppedReads);
      rightValues[rightValues.length - 1] = 0.6;
      expect(drain(elementsEqualSteps(left, right))).toBe(false);
      expect(drain(classifyReplacementSteps(left, right))).toEqual(["geometry"]);
      expect(values).toEqual(
        Array.from({ length: 30_000 }, (_, index) => (index % 3 === 2 ? 0.5 : index)),
      );
    },
  );

  it("preserves typed === and ordinary Object.is sample equality", () => {
    for (const typed of [false, true]) {
      const points = (value: number) =>
        runtimeSamples(typed ? new Float64Array([value, 1, 0.5]) : [value, 1, 0.5]);
      const left = { ...highlighter(), points: points(-0) };
      const right = { ...highlighter(), points: points(0) };
      expect(elementsEqual(left, right)).toBe(typed);
      expect(classifyReplacement(left, right)).toEqual(typed ? [] : ["geometry"]);
      const nanLeft = { ...left, points: points(NaN) };
      const nanRight = { ...right, points: points(NaN) };
      expect(elementsEqual(nanLeft, nanRight)).toBe(!typed);
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid sample count %s", (samplesPerStep) => {
    const stroke = highlighter();
    expect(() => elementsEqualSteps(stroke, stroke, samplesPerStep).next()).toThrow(RangeError);
    expect(() => classifyReplacementSteps(stroke, stroke, samplesPerStep).next()).toThrow(
      RangeError,
    );
  });
});
