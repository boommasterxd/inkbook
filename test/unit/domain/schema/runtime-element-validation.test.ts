import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateInkElementV1,
  validateRuntimeInkElementV1,
  validateRuntimeInkElementV1Steps,
} from "../../../../src/domain/schema/element-validation";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/constants";
import { assertJsonTreeSteps } from "../../../../src/domain/schema/validation-internals";
import * as sampleRanges from "../../../../src/domain/schema/stroke-sample-range-validation";
import { validatedSampleExtrema } from "../../../../src/domain/schema/stroke-sample-extrema";
import { coordinateSystem, line, rectangle, stroke, table } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

function drain(value: unknown, limits = FILE_SCHEMA_LIMITS) {
  const steps = validateRuntimeInkElementV1Steps(value, { limits }, 32, 16);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function longStroke(typed: boolean) {
  const points = Array.from({ length: 1024 * 3 }, (_, index) =>
    index % 3 === 2 ? 0.5 : Math.floor(index / 3),
  );
  return { ...stroke(), points: typed ? new Float64Array(points) : points };
}

describe("resumable runtime element validation", () => {
  it.each([stroke(), line(), rectangle(), coordinateSystem(), table()])(
    "preserves canonical JSON results for $kind",
    (element) => {
      const expected = validateInkElementV1(element);
      expect(drain(element)).toEqual(expected);
      expect(validateRuntimeInkElementV1(element)).toEqual(expected);
    },
  );

  it.each([false, true])("validates long strokes in bounded sample leaves (typed=%s)", (typed) => {
    const element = longStroke(typed);
    const reads = vi.spyOn(sampleRanges, "assertStrokeSampleRange");
    const result = drain(element);

    expect(result).toEqual(validateRuntimeInkElementV1(element));
    expect(result).toMatchObject({ ok: true, statistics: { strokePoints: 1024, strokes: 1 } });
    expect(reads.mock.calls.slice(0, 64)).toHaveLength(64);
    for (const call of reads.mock.calls.slice(0, 64)) {
      expect(call[4].end - call[4].start).toBe(16 * 3);
    }
    expect(validatedSampleExtrema(element.points)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 1023,
      maxY: 1023,
    });
    expect(validateInkElementV1(element).ok).toBe(!typed);
  });

  it.each([
    ["NaN", NaN, 0, "invalid-number"],
    ["negative zero coordinate", -0, 0, "invalid-number"],
    ["coordinate range", FILE_SCHEMA_LIMITS.absoluteCoordinate + 1, 0, "invalid-range"],
    ["negative zero pressure", -0, 2, "invalid-range"],
    ["pressure range", 1.1, 2, "invalid-range"],
  ] as const)("preserves %s failures", (_name, value, component, code) => {
    for (const typed of [false, true]) {
      const element = longStroke(typed);
      element.points[1023 * 3 + component] = value;
      const expected = validateRuntimeInkElementV1(element);
      expect(drain(element)).toEqual(expected);
      expect(expected).toMatchObject({ ok: false, error: { code } });
      if (!typed) expect(expected).toEqual(validateInkElementV1(element));
    }
  });

  it.each([false, true])("stops reading an abandoned producer (typed=%s)", (typed) => {
    const element = longStroke(typed);
    const reads = vi.spyOn(sampleRanges, "assertStrokeSampleRange");
    const steps = validateRuntimeInkElementV1Steps(element, {}, 32, 16);
    while (reads.mock.calls.length === 0) expect(steps.next().done).toBe(false);
    expect(reads).toHaveBeenCalledTimes(1);
    steps.return({
      ok: false,
      error: { code: "invalid-number", path: "$", message: "Cancelled." },
    });
    expect(steps.next().done).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(validatedSampleExtrema(element.points)).toBeUndefined();
  });

  it("keeps count limits and translated-coordinate failures equivalent", () => {
    const element = {
      ...longStroke(true),
      offset: { x: FILE_SCHEMA_LIMITS.absoluteCoordinate, y: 0 },
    };
    expect(drain(element)).toEqual(validateRuntimeInkElementV1(element));
    expect(drain(element)).toMatchObject({ ok: false, error: { code: "invalid-range" } });
    const limits = { ...FILE_SCHEMA_LIMITS, strokePoints: 100 };
    expect(drain(longStroke(true), limits)).toEqual(
      validateRuntimeInkElementV1(longStroke(true), { limits }),
    );
  });
});

describe("resumable JSON array preflight", () => {
  it("bounds descriptor reads before and during traversal", () => {
    const values = Array.from({ length: 512 }, () => 1);
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
    const steps = assertJsonTreeSteps(values, 1024, 32);
    let previous = 0;
    let step = steps.next();
    while (!step.done) {
      const reads = descriptors.mock.calls.filter(([value]) => value === values).length;
      expect(reads - previous).toBeLessThanOrEqual(32);
      previous = reads;
      step = steps.next();
    }
    expect(step.value).toBe(1);
    expect(descriptors.mock.calls.filter(([value]) => value === values)).toHaveLength(1024);
  });
});
