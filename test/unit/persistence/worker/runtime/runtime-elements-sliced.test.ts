import { expect, it, vi } from "vitest";
import * as strokeSamples from "../../../../../src/domain/elements/public";
import { validateInkSnapshotV1 } from "../../../../../src/domain/schema/public";
import { stroke } from "../../../domain/schema/fixtures";
import { observeSchemaArray } from "../../../../fixtures/domain/schema-array-work";
import {
  copySnapshotToRuntime,
  copySnapshotToRuntimeSliced,
  validateRuntimeSamplesSteps,
} from "../../../../../src/persistence/worker/runtime/runtime-elements";
import { snapshot } from "./fixtures";

it("copies and validates long strokes in bounded chunks and reuses frozen samples", async () => {
  const source = stroke();
  const points = Array.from({ length: 12_000 }, (_, index) =>
    index % 3 === 2 ? 0.5 : Math.floor(index / 3),
  );
  Object.freeze(points);
  source.points = points;
  const copies = new WeakMap();
  let checkpoints = 0;
  const context = {
    checkpoint: async () => {
      checkpoints += 1;
    },
    signal: new AbortController().signal,
    workProfile: { inputByteLimit: 4_096, nodeLimit: 64, outputByteLimit: 16_384 },
  };
  const first = await copySnapshotToRuntimeSliced(
    { ...snapshot(), elements: [source] },
    context,
    copies,
  );
  expect(checkpoints).toBe(72);
  const copied = first.elements[0];
  expect(copied?.kind).toBe("stroke");
  if (copied?.kind !== "stroke") return;
  expect(copied.points).toBeInstanceOf(Float64Array);
  expect(copied.points).toEqual(new Float64Array(points));
  const again = await copySnapshotToRuntimeSliced(
    { ...snapshot(), elements: [source] },
    context,
    copies,
  );
  expect(again.elements[0]).toMatchObject({ points: copied.points });
  expect(checkpoints).toBe(73);
});

it("does not publish partial stroke copies when cancellation interrupts a chunk", async () => {
  const source = stroke();
  source.points = Array.from({ length: 12_000 }, (_, index) =>
    index % 3 === 2 ? 0.5 : 100 + (Math.floor(index / 3) % 10),
  );
  Object.freeze(source.points);
  const input = { ...snapshot(), elements: [source] };
  const validation = validateInkSnapshotV1(input);
  if (!validation.ok) throw new Error(validation.error.message);
  const copies = new WeakMap();
  const controller = new AbortController();
  let checkpoints = 0;
  await expect(
    copySnapshotToRuntimeSliced(
      input,
      {
        checkpoint: async () => {
          checkpoints += 1;
          if (checkpoints === 2) controller.abort();
          controller.signal.throwIfAborted();
        },
        signal: controller.signal,
        workProfile: { inputByteLimit: 4_096, nodeLimit: 64, outputByteLimit: 16_384 },
      },
      copies,
      validation.derivations,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(checkpoints).toBe(2);
  expect(copies.has(source.points)).toBe(false);
  const retry = await copySnapshotToRuntimeSliced(
    input,
    {
      checkpoint: async () => {},
      signal: new AbortController().signal,
      workProfile: { inputByteLimit: 4_096, nodeLimit: 64, outputByteLimit: 16_384 },
    },
    copies,
    validation.derivations,
  );
  expect(retry.elements[0]?.kind === "stroke" && retry.elements[0].points).toBe(
    copies.get(source.points),
  );
});

it("uses matching validation derivations to avoid scanning copied samples again", async () => {
  const source = stroke();
  const values = Array.from({ length: 12_000 }, (_, index) =>
    index % 3 === 2 ? 0.5 : 100 + (Math.floor(index / 3) % 10),
  );
  const { observed: points, work } = observeSchemaArray(values);
  Object.freeze(points);
  source.points = points;
  const input = { ...snapshot(), elements: [source] };
  const validation = validateInkSnapshotV1(input);
  if (!validation.ok) throw new Error(validation.error.message);
  work.indexedReads = 0;
  const assertion = vi.spyOn(strokeSamples, "assertStrokeSamplesV1");
  const checkpoints: number[] = [];
  try {
    const context = {
      checkpoint: async () => {
        checkpoints.push(assertion.mock.calls.length);
      },
      signal: new AbortController().signal,
      workProfile: { inputByteLimit: 4_096, nodeLimit: 64, outputByteLimit: 16_384 },
    };
    const sliced = await copySnapshotToRuntimeSliced(
      input,
      context,
      undefined,
      validation.derivations,
    );
    expect(work.indexedReads).toBe(12_000);
    const direct = copySnapshotToRuntime(input, undefined, validation.derivations);
    expect(work.indexedReads).toBe(24_000);
    expect(assertion).not.toHaveBeenCalled();
    expect(checkpoints).toHaveLength(48);
    expect(sliced.elements[0]?.kind).toBe("stroke");
    expect(sliced.elements[0]?.kind === "stroke" && sliced.elements[0].points).toEqual(
      new Float64Array(values),
    );
    expect(direct.elements[0]?.kind === "stroke" && direct.elements[0].points).toEqual(
      new Float64Array(values),
    );
    expect(sliced.elements[0]).not.toBe(source);
  } finally {
    assertion.mockRestore();
  }
});

it("captures mutable stroke headers before sample copying can yield", async () => {
  const source = stroke();
  const originalWidth = source.style.width;
  const originalPivot = { ...source.pivot };
  source.points = Array.from({ length: 12_000 }, (_, index) => (index % 3 === 2 ? 0.5 : 100));
  let changed = false;
  const copied = await copySnapshotToRuntimeSliced(
    { ...snapshot(), elements: [source] },
    {
      checkpoint: () => {
        if (!changed) {
          changed = true;
          Object.assign(source.style, { width: 22 });
          source.pivot.x = 300;
          source.points = [1, 1, 1];
        }
        return undefined;
      },
      signal: new AbortController().signal,
    },
  );
  expect(copied.elements[0]).toMatchObject({
    pivot: originalPivot,
    style: { width: originalWidth },
  });
  expect(copied.elements[0]?.kind === "stroke" && copied.elements[0].points.length).toBe(12_000);
});

it("validates direct unproven samples and rejects unrelated derivations", async () => {
  const source = stroke();
  source.points = [100, 100, 0.5, Number.NaN, 100, 0.5];
  const input = { ...snapshot(), elements: [source] };
  const context = {
    checkpoint: async () => {},
    signal: new AbortController().signal,
    workProfile: { inputByteLimit: 4_096, nodeLimit: 64, outputByteLimit: 16_384 },
  };
  expect(() => copySnapshotToRuntime(input)).toThrow(RangeError);
  await expect(copySnapshotToRuntimeSliced(input, context)).rejects.toThrow(RangeError);

  const valid = { ...snapshot(), elements: [stroke()] };
  const validation = validateInkSnapshotV1(valid);
  if (!validation.ok) throw new Error(validation.error.message);
  expect(() => copySnapshotToRuntime(input, undefined, validation.derivations)).toThrow(
    "matching validation derivations",
  );
  for (const stepSize of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => validateRuntimeSamplesSteps(new Float64Array([0, 0, 1]), stepSize).next()).toThrow(
      RangeError,
    );
});
