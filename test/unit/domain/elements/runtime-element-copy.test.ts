import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureRuntimeElementHeader,
  captureImmutableRuntimeElementHeader,
  attachCapturedStrokeSamples,
  preparedInsertionHeader,
  copyRuntimeElementSteps,
  copyStrokeSamplesToRuntimeSteps,
  copyStrokeSamplesToImmutableJsonSteps,
  stageStrokeSamplesSteps,
} from "../../../../src/domain/elements/runtime-element-copy";
import * as sampleCopy from "../../../../src/domain/elements/runtime-sample-copy";
import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/constants";
import { validateRuntimeInkElementV1 } from "../../../../src/domain/schema/element-validation";
import {
  copySampleBufferSteps,
  isCapturedJsonSampleArray,
} from "../../../../src/domain/elements/runtime-sample-copy-producer";
import {
  assertJsonTreeSteps,
  toValidationError,
} from "../../../../src/domain/schema/validation-internals";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { observePointReads } from "../../../fixtures/rendering/point-reads";
import { rectangle, stroke, table } from "../schema/fixtures";

afterEach(() => vi.restoreAllMocks());

it("reuses only privately captured immutable headers while keeping attached samples untrusted", () => {
  const source = stroke();
  const captured = captureImmutableRuntimeElementHeader(source);
  const wrapped = attachCapturedStrokeSamples(captured, source.points);
  source.style = { ...source.style, width: 22 };
  source.points[0] = 999;
  expect(preparedInsertionHeader(wrapped)?.style).toEqual(captured.style);
  expect(captured.style).not.toEqual(source.style);
  expect(wrapped.points).toBe(source.points);
  expect(preparedInsertionHeader(Object.freeze({ ...wrapped }))).toBeUndefined();
  const getter = vi.fn(() => captured.style);
  const forged = Object.defineProperty({}, "style", { get: getter, enumerable: true });
  expect(() => attachCapturedStrokeSamples(forged, source.points)).toThrow(TypeError);
  expect(getter).not.toHaveBeenCalled();
  expect(preparedInsertionHeader(captureImmutableRuntimeElementHeader(rectangle()))?.kind).toBe(
    "rectangle",
  );
  const typedHeader = captureImmutableRuntimeElementHeader({
    ...source,
    unexpected: new Float64Array([1]),
  });
  expect(preparedInsertionHeader(typedHeader)).toBeUndefined();
  expect(
    captureImmutableRuntimeElementHeader(
      { ...rectangle(), pointsBufferIndex: 0 },
      new Set(["pointsBufferIndex"]),
    ).pointsBufferIndex,
  ).toBe(0);
});

it("rejects class prototypes and forged native Object constructors in both capture and validation", () => {
  class CustomRecord {}
  function ObjectImpostor() {}
  const getter = vi.fn(() => Object);
  const fake = Object.create(null) as object;
  Object.defineProperty(fake, "constructor", { value: ObjectImpostor });
  Object.defineProperty(ObjectImpostor, "prototype", { value: fake });
  Object.defineProperty(ObjectImpostor, "name", { value: "Object" });
  Object.defineProperty(ObjectImpostor, "toString", {
    value: () => Function.prototype.toString.call(Object),
  });
  const nativeMismatch = Object.create(null) as object;
  Object.defineProperty(nativeMismatch, "constructor", { value: Object });
  const accessor = Object.create(null) as object;
  Object.defineProperty(accessor, "constructor", { get: getter });
  for (const prototype of [
    CustomRecord.prototype,
    Object.create(null) as object,
    fake,
    nativeMismatch,
    accessor,
  ]) {
    const source = Object.assign(Object.create(prototype) as object, stroke());
    expect(() => captureRuntimeElementHeader(source)).toThrow(TypeError);
    expect(validateRuntimeInkElementV1(source)).toMatchObject({
      ok: false,
      error: { code: "invalid-json-value" },
    });
  }
  expect(getter).not.toHaveBeenCalled();
  const nullPrototype = Object.assign(Object.create(null) as object, stroke());
  expect(captureRuntimeElementHeader(nullPrototype)).toMatchObject({ kind: "stroke" });
  expect(validateRuntimeInkElementV1(nullPrototype)).toMatchObject({ ok: true });
});

it("registers copied JSON structure only after completion and never trusts external frozen arrays", () => {
  const external = Object.freeze([0, 0, 0.5]);
  expect(isCapturedJsonSampleArray(external)).toBe(false);
  expect(isCapturedJsonSampleArray(new Proxy(external, {}))).toBe(false);
  const copy = vi.spyOn(sampleCopy, "copySampleRange");
  const steps = copyStrokeSamplesToImmutableJsonSteps(external);
  steps.next();
  const unpublished = copy.mock.calls[0]![1];
  expect(isCapturedJsonSampleArray(unpublished)).toBe(false);
  steps.return([]);
  expect(isCapturedJsonSampleArray(unpublished)).toBe(false);
  const captured = finishGeometrySteps(copyStrokeSamplesToImmutableJsonSteps(external));
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Reflect.set(captured, "0", 99)).toBe(false);
  expect(isCapturedJsonSampleArray(captured)).toBe(true);
  expect(isCapturedJsonSampleArray([...captured])).toBe(false);
});

function jsonTreeOutcome(samples: number[], depth: number, nodes: number, entries: number) {
  let root: unknown = { points: samples };
  for (let level = 2; level < depth; level += 1) root = { child: root };
  try {
    return {
      maximumDepth: finishGeometrySteps(assertJsonTreeSteps(root, nodes, 2, false, entries)),
    };
  } catch (error: unknown) {
    return { error: toValidationError(error) };
  }
}

it.each([2, 16, 17])(
  "preserves external JSON statistics and failures at container depth %s",
  (depth) => {
    const external = [0, 0, 0.5, 1, 1, 0.5];
    const captured = finishGeometrySteps(copyStrokeSamplesToImmutableJsonSteps(external));
    for (const [nodes, entries] of [
      [depth + 6, 6],
      [depth + 5, 6],
      [depth + 6, 5],
    ] as const) {
      expect(jsonTreeOutcome(captured, depth, nodes, entries)).toEqual(
        jsonTreeOutcome(external, depth, nodes, entries),
      );
    }
    const outcome = jsonTreeOutcome(captured, depth, depth + 6, 6);
    if (depth <= 16) expect(outcome).toEqual({ maximumDepth: depth });
    else expect(outcome).toMatchObject({ error: { code: "maximum-depth-exceeded" } });
  },
);

it.each([Number.NaN, -3, 0, 1, Number.POSITIVE_INFINITY])(
  "rejects invalid exported sample-copy steps without publishing a proof (%s)",
  (valuesPerStep) => {
    const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
    const external = [0, 0, 0.5];
    expect(() =>
      finishGeometrySteps(copySampleBufferSteps(external, 3, valuesPerStep, "json")),
    ).toThrow(RangeError);
    expect(allocate).not.toHaveBeenCalled();
    expect(isCapturedJsonSampleArray(external)).toBe(false);
  },
);

it.each([Number.NaN, -3, 0, 6, Number.POSITIVE_INFINITY])(
  "rejects mismatched sample-copy lengths without publishing a proof (%s)",
  (length) => {
    const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
    const external = [0, 0, 0.5];
    expect(() => finishGeometrySteps(copySampleBufferSteps(external, length, 3, "json"))).toThrow(
      RangeError,
    );
    expect(allocate).not.toHaveBeenCalled();
    expect(isCapturedJsonSampleArray(external)).toBe(false);
  },
);

it("prevents caller flags from selecting immutable preparation", () => {
  const external = [0, 0, 0.5];
  const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
  expect(() => copySampleBufferSteps(external, 3, 3, "immutable-json" as "json")).toThrow(
    TypeError,
  );
  expect(allocate).not.toHaveBeenCalled();
  const copied = finishGeometrySteps(copySampleBufferSteps(external, 3, 3, "json"));
  expect(isCapturedJsonSampleArray(copied)).toBe(false);
});

it.each([
  [0, Number.NaN, 0.5],
  [Number.POSITIVE_INFINITY, 0, 0.5],
  [-0, 0, 0.5],
  [0, 0, 0.50001],
  [1_000_001, 0, 0.5],
])("keeps complete semantic validation for copied numeric samples (%s)", (...values) => {
  const captured = finishGeometrySteps(copyStrokeSamplesToImmutableJsonSteps(values));
  expect(isCapturedJsonSampleArray(captured)).toBe(values.every(Number.isFinite));
  expect(validateRuntimeInkElementV1({ ...stroke(), points: captured }).ok).toBe(false);
});

it("checks excluded large body fields without copying them or invoking accessors", () => {
  const elements = Array.from({ length: 10_000 }, () => rectangle());
  const source = { page: { margin: 24.3 }, elements };
  expect(captureRuntimeElementHeader(source, new Set(["elements"]))).toEqual({
    page: { margin: 24.3 },
  });
  const accessor = vi.fn(() => elements);
  Object.defineProperty(source, "elements", { get: accessor, enumerable: true });
  expect(() => captureRuntimeElementHeader(source, new Set(["elements"]))).toThrow(
    "enumerable data values",
  );
  expect(accessor).not.toHaveBeenCalled();
});

describe("runtime element private staging", () => {
  it.each([false, true])(
    "preserves sample representation and exact numbers (typed: %s)",
    (typed) => {
      const values = [-0, Number.NaN, Number.POSITIVE_INFINITY, 2.0001, -3, 1.0001];
      const source = typed ? new Float64Array(values) : values;
      const candidate = finishGeometrySteps(stageStrokeSamplesSteps(source));
      expect(candidate).not.toBe(source);
      expect(candidate instanceof Float64Array).toBe(typed);
      values.forEach((value, index) => expect(Object.is(candidate[index], value)).toBe(true));
      source[0] = 7;
      expect(Object.is(candidate[0], -0)).toBe(true);
    },
  );

  it("converts wire representation without rounding or canonicalizing numeric values", () => {
    const candidate = finishGeometrySteps(
      copyStrokeSamplesToRuntimeSteps([-0, Number.NaN, 0.123456789]),
    );
    expect(candidate).toBeInstanceOf(Float64Array);
    expect(Object.is(candidate[0], -0)).toBe(true);
    expect(Number.isNaN(candidate[1])).toBe(true);
    expect(candidate[2]).toBe(0.123456789);
  });

  it("captures replaceable headers and the sample reference before the first step", () => {
    const source = stroke();
    source.offset = { x: 10, y: 20 };
    const originalPoints = source.points;
    const steps = copyRuntimeElementSteps(source);
    source.pivot.x = 900;
    source.style = { ...source.style, width: 22 };
    source.offset.x = 800;
    source.points = [7, 8, 0.5];
    steps.next();
    originalPoints[0] = 999;
    const candidate = finishGeometrySteps(steps);
    expect(candidate.pivot.x).toBe(110);
    expect(candidate.style.width).toBe(4);
    expect(candidate.offset).toEqual({ x: 10, y: 20 });
    expect(candidate.points).toEqual([100, 100, 0.5, 120, 120, 1]);
  });

  it("preserves malformed unknown fields for private-candidate schema validation", () => {
    const source = { ...stroke(), unexpected: { nested: [1, 2] } };
    const candidate = finishGeometrySteps(copyRuntimeElementSteps(source));
    source.unexpected.nested[0] = 99;
    expect(candidate.unexpected.nested).toEqual([1, 2]);
    expect(validateRuntimeInkElementV1(candidate).ok).toBe(false);
    expect(finishGeometrySteps(copyRuntimeElementSteps(rectangle()))).toEqual(rectangle());
    expect(
      finishGeometrySteps(copyRuntimeElementSteps({ ...table(), columnOffsets: [35, 75] }))
        .columnOffsets,
    ).toEqual([35, 75]);
  });

  it.each([
    [-0, 0, 0.5],
    [0, Number.NaN, 0.5],
    [1_000_001, 0, 0.5],
    [0, 0, 1.0001],
  ])(
    "retains invalid numeric samples until the private candidate is rejected (%s)",
    (...values) => {
      const candidate = finishGeometrySteps(
        copyRuntimeElementSteps({ ...stroke(), points: values }),
      );
      values.forEach((value, index) =>
        expect(Object.is(candidate.points[index], value)).toBe(true),
      );
      expect(validateRuntimeInkElementV1(candidate).ok).toBe(false);
    },
  );

  it("reuses an identical private buffer without reading it or allocating a copy", () => {
    let reads = 0;
    const owned = observePointReads([0, 0, 0.5], () => {
      reads += 1;
    });
    const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
    expect(finishGeometrySteps(stageStrokeSamplesSteps(owned, owned))).toBe(owned);
    expect(reads).toBe(0);
    expect(allocate).not.toHaveBeenCalled();
  });
});

describe("runtime sample comparison and bounded copy work", () => {
  it("proves frozen sample data within the real copy ranges without a frozen-array prepass", () => {
    const source = Object.freeze(Array.from({ length: MAX_STROKE_POINTS * 3 }, () => 0));
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
    const frozen = vi.spyOn(Object, "isFrozen");
    const steps = stageStrokeSamplesSteps(source);
    steps.next();
    expect(descriptors.mock.calls.filter(([value]) => value === source)).toHaveLength(256 * 3 + 1);
    finishGeometrySteps(steps);
    expect(descriptors.mock.calls.filter(([value]) => value === source)).toHaveLength(
      source.length + 1,
    );
    expect(frozen.mock.calls.some(([value]) => value === source)).toBe(false);
    expect(sampleCopy.isImmutableStrokeSampleSource(source)).toBe(true);
  });

  it("reads each external value once and reuses an exactly matching owned buffer", () => {
    const owned = Array.from({ length: MAX_STROKE_POINTS * 3 }, () => 0);
    let reads = 0;
    const external = observePointReads([...owned], () => {
      reads += 1;
    });
    const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
    const compare = vi.spyOn(sampleCopy, "compareSampleRange");
    expect(finishGeometrySteps(stageStrokeSamplesSteps(external, owned))).toBe(owned);
    expect(reads).toBe(owned.length);
    expect(allocate).not.toHaveBeenCalled();
    expect(compare).toHaveBeenCalledTimes(MAX_STROKE_POINTS / 256);
    compare.mock.calls.forEach(([, , start, end]) =>
      expect(end - start).toBeLessThanOrEqual(256 * 3),
    );
  });

  it("copies the verified prefix from private ownership after a late external change", () => {
    const owned = [1, 2, 0.5, 4, 5, 0.5, 7, 8, 0.5];
    const values = [...owned];
    let reads = 0;
    const external = observePointReads(values, () => {
      reads += 1;
    });
    const steps = stageStrokeSamplesSteps(external, owned, 1);
    steps.next();
    values[0] = Number.NaN;
    values[3] = -0;
    steps.next();
    values[3] = 99;
    const candidate = finishGeometrySteps(steps);
    expect(candidate).not.toBe(owned);
    expect(candidate[0]).toBe(1);
    expect(Object.is(candidate[3], -0)).toBe(true);
    expect(reads).toBe(values.length);
    expect(owned[3]).toBe(4);
  });

  it("compares signed zero exactly and copies different sample representations", () => {
    const owned = [0, 0, 0.5];
    const candidate = finishGeometrySteps(stageStrokeSamplesSteps([-0, 0, 0.5], owned));
    expect(candidate).not.toBe(owned);
    expect(Object.is(candidate[0], -0)).toBe(true);
    const typed = finishGeometrySteps(stageStrokeSamplesSteps(new Float64Array(owned), owned));
    expect(typed).toBeInstanceOf(Float64Array);
  });

  it("bounds real copy ranges and stops reads immediately when consumption is cancelled", () => {
    let reads = 0;
    const source = observePointReads(
      Array.from({ length: MAX_STROKE_POINTS * 3 }, () => 0),
      () => {
        reads += 1;
      },
    );
    const copy = vi.spyOn(sampleCopy, "copySampleRange");
    const steps = stageStrokeSamplesSteps(source);
    expect(steps.next().done).toBe(false);
    expect(reads).toBe(256 * 3);
    steps.return([]);
    expect(steps.next().done).toBe(true);
    expect(reads).toBe(256 * 3);
    expect(copy.mock.calls.map(([, , start, end]) => end - start)).toEqual([256 * 3]);
  });
});

describe("runtime copy input limits", () => {
  it.each(["kind", "pivot", "points"])(
    "rejects header accessors without invoking them (%s)",
    (key) => {
      const source = stroke();
      const getter = vi.fn(() => source.pivot);
      Object.defineProperty(source, key, { get: getter, enumerable: true });
      expect(() => captureRuntimeElementHeader(source)).toThrow(TypeError);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("rejects custom prototypes, symbols, hidden fields, and malformed nested arrays", () => {
    const inherited = Object.assign(Object.create({ extra: true }) as object, stroke());
    const symbolic = { ...stroke(), [Symbol("extra")]: 1 };
    const hidden = stroke();
    Object.defineProperty(hidden, "extra", { value: 1 });
    const arrays = [new Array<number>(2), Object.assign([1, 2], { extra: 3 })];
    for (const source of [
      inherited,
      symbolic,
      hidden,
      ...arrays.map((axes) => ({ ...stroke(), axes })),
    ]) {
      expect(() => captureRuntimeElementHeader(source)).toThrow();
    }
  });

  it("rejects sparse, accessor, and custom-key sample arrays before returning a candidate", () => {
    const getter = vi.fn(() => 0);
    const accessor = [0, 0, 0.5];
    Object.defineProperty(accessor, "0", { get: getter, enumerable: true });
    const sparse = [0, 0, 0.5];
    Reflect.deleteProperty(sparse, "1");
    for (const source of [accessor, sparse, Object.assign([0, 0, 0.5], { extra: true })]) {
      expect(() => finishGeometrySteps(stageStrokeSamplesSteps(source))).toThrow(TypeError);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("registers frozen own numeric data only after a complete bounded copy", () => {
    const source = Object.freeze([0, 0, 0.5, 1, 1, 0.5]);
    expect(sampleCopy.isImmutableStrokeSampleSource(source)).toBe(false);
    const cancelled = stageStrokeSamplesSteps(source, undefined, 1);
    cancelled.next();
    cancelled.return([]);
    expect(sampleCopy.isImmutableStrokeSampleSource(source)).toBe(false);
    finishGeometrySteps(stageStrokeSamplesSteps(source));
    expect(sampleCopy.isImmutableStrokeSampleSource(source)).toBe(true);
    const mutable = [0, 0, 0.5];
    finishGeometrySteps(stageStrokeSamplesSteps(mutable));
    expect(sampleCopy.isImmutableStrokeSampleSource(mutable)).toBe(false);
    const accessor = [0, 0, 0.5];
    Object.defineProperty(accessor, "0", { get: () => 0, enumerable: true });
    Object.freeze(accessor);
    expect(() => finishGeometrySteps(stageStrokeSamplesSteps(accessor))).toThrow(TypeError);
    expect(sampleCopy.isImmutableStrokeSampleSource(accessor)).toBe(false);
  });

  it.each([
    [],
    [0, 0],
    new Array<number>(MAX_STROKE_POINTS * 3 + 3),
    [0, 0, "0.5"],
    new Int32Array(3),
  ])("rejects buffer bounds and type misuse before coercion", (source) => {
    expect(() => finishGeometrySteps(stageStrokeSamplesSteps(source as number[]))).toThrow();
  });

  it.each([0, -1, 0.5, MAX_STROKE_POINTS + 1, Number.POSITIVE_INFINITY])(
    "rejects unsupported range sizes (%s)",
    (size) =>
      expect(() => stageStrokeSamplesSteps([0, 0, 0.5], undefined, size)).toThrow(RangeError),
  );

  it("bounds nested header work and rejects cyclic or oversized arrays", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => captureRuntimeElementHeader({ ...stroke(), cycle })).toThrow(TypeError);
    expect(() =>
      captureRuntimeElementHeader({ ...stroke(), extra: new Array<number>(257) }),
    ).toThrow(RangeError);
    let nested: object = {};
    for (let index = 0; index < 20; index += 1) nested = { child: nested };
    expect(() => captureRuntimeElementHeader({ ...stroke(), extra: nested })).toThrow(RangeError);
  });

  it("preserves own reserved names without mutating the clone prototype", () => {
    const source = stroke();
    Object.defineProperty(source, "__proto__", { value: { extra: true }, enumerable: true });
    const candidate = captureRuntimeElementHeader(source);
    expect(Object.getPrototypeOf(candidate)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(candidate, "__proto__")?.value).toEqual({ extra: true });
  });
});
