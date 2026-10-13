import { afterEach, expect, it, vi } from "vitest";
import {
  copyImmutableJsonSampleSteps,
  copySampleBufferSteps,
  isCapturedJsonSampleArray,
} from "../../../../src/domain/elements/runtime-sample-copy-producer";
import * as sampleCopy from "../../../../src/domain/elements/runtime-sample-copy";
import { MutationPreparationScheduler } from "../../../../src/domain/store/mutation-preparation-scheduler";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { observeSchemaArray } from "../../../fixtures/domain/schema-array-work";

afterEach(() => vi.restoreAllMocks());

function externalSamples(kind: string, getter: () => number) {
  const values = [0, 0, 0.5];
  switch (kind) {
    case "frozen":
      return Object.freeze(values);
    case "proxy":
      return new Proxy(finishGeometrySteps(copyImmutableJsonSampleSteps(values)), {});
    case "typed":
      return new Float64Array(values);
    case "accessor":
      return Object.defineProperty(values, "0", { get: getter, enumerable: true });
    default:
      return values;
  }
}

it("copies private captured samples once without structural inspection and keeps outputs independent", () => {
  const values = Array.from({ length: 1536 }, (_, index) => index % 3);
  const observed = observeSchemaArray(new Array<number>(values.length));
  // Observe the actual privately produced array, preserving its registered identity.
  vi.spyOn(sampleCopy, "allocateSampleCopy").mockReturnValueOnce(observed.observed);
  const captured = finishGeometrySteps(copyImmutableJsonSampleSteps(values));
  observed.work.indexedReads = 0;
  observed.work.descriptorReads = 0;
  const keyWalk = vi.spyOn(sampleCopy, "assertSampleArrayKeysSteps");
  const steps = copySampleBufferSteps(captured, captured.length, 768, "json");
  let step;
  do {
    const before = observed.work.indexedReads;
    step = steps.next();
    expect(observed.work.indexedReads - before).toBeLessThanOrEqual(768);
  } while (!step.done);
  expect(observed.work).toEqual({ indexedReads: values.length, descriptorReads: 0 });
  expect(keyWalk).not.toHaveBeenCalled();
  expect(step.value).toEqual(values);
  expect(step.value).not.toBe(captured);
  expect(isCapturedJsonSampleArray(step.value)).toBe(false);
  step.value[0] = 99;
  expect(captured[0]).toBe(0);
  expect(values[0]).toBe(0);
});

it.each(["mutable", "frozen", "proxy", "typed", "accessor"] as const)(
  "requires private provenance for %s sources and preserves external validation",
  (kind) => {
    const getter = vi.fn(() => 0);
    const source = externalSamples(kind, getter);
    const checkedCopy = vi.spyOn(sampleCopy, "copySampleRange");
    const externalCopy = () => finishGeometrySteps(copySampleBufferSteps(source, 3, 3, "json"));
    if (kind === "accessor") expect(externalCopy).toThrow(TypeError);
    else expect(externalCopy()).toEqual([0, 0, 0.5]);
    expect(checkedCopy).toHaveBeenCalledOnce();
    expect(getter).not.toHaveBeenCalled();
  },
);

it("does not trust producer copies that contain non-finite values", () => {
  const source = finishGeometrySteps(copyImmutableJsonSampleSteps([0, Number.NaN, 0.5]));
  const checkedCopy = vi.spyOn(sampleCopy, "copySampleRange");
  expect(finishGeometrySteps(copySampleBufferSteps(source, 3, 3, "json"))).toEqual(source);
  expect(checkedCopy).toHaveBeenCalledOnce();
  expect(isCapturedJsonSampleArray(source)).toBe(false);
});

it("discards a cancelled private copy without publishing its incomplete output", async () => {
  const source = finishGeometrySteps(
    copyImmutableJsonSampleSteps(Array.from({ length: 1536 }, (_, index) => index % 3)),
  );
  const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
  let cancelled = false;
  const work = new MutationPreparationScheduler({
    isCancelled: () => cancelled,
    shouldYield: () => allocate.mock.calls.length > 0,
    yieldControl: async () => {
      cancelled = true;
    },
  });
  expect(await work.run(copyImmutableJsonSampleSteps(source))).toBe("cancelled");
  expect(allocate).toHaveBeenCalledOnce();
  const partial = allocate.mock.results[0]!.value as number[];
  expect(partial.slice(0, 768)).toEqual(source.slice(0, 768));
  expect(Object.prototype.hasOwnProperty.call(partial, "768")).toBe(false);
  expect(isCapturedJsonSampleArray(partial)).toBe(false);
  expect(Object.isFrozen(partial)).toBe(false);
  expect(isCapturedJsonSampleArray(source)).toBe(true);
  expect(finishGeometrySteps(copySampleBufferSteps(source, source.length, 768, "runtime"))).toEqual(
    new Float64Array(source),
  );
});
