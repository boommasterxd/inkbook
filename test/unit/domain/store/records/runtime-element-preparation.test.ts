import { afterEach, describe, expect, it, vi } from "vitest";

import * as replacementValidation from "../../../../../src/domain/elements/runtime-replacement-validation";
import { MutationPreparationScheduler } from "../../../../../src/domain/store/mutations/mutation-preparation-scheduler";
import { prepareRuntimeElement } from "../../../../../src/domain/store/records/runtime-element-preparation";
import { highlighter, rectangle } from "../fixtures";

afterEach(() => vi.restoreAllMocks());

describe("runtime element preparation synchronous completion", () => {
  it.each([
    { kind: "rectangle", create: rectangle },
    { kind: "stroke", create: highlighter },
  ])(
    "copies, validates and freezes a $kind without creating an asynchronous continuation",
    ({ create }) => {
      const source = create();
      const yieldControl = vi.fn(async () => undefined);
      const work = new MutationPreparationScheduler({ shouldYield: () => false, yieldControl });
      const prepared = prepareRuntimeElement(source, undefined, undefined, work);
      if (prepared === "cancelled" || prepared instanceof Promise) {
        throw new Error("Expected synchronous preparation.");
      }
      expect(prepared).toEqual(source);
      expect(prepared).not.toBe(source);
      expect(prepared.style).not.toBe(source.style);
      expect(Object.isFrozen(prepared)).toBe(true);
      expect(Object.isFrozen(prepared.style)).toBe(true);
      expect(Object.isFrozen(source)).toBe(false);
      expect(yieldControl).not.toHaveBeenCalled();
    },
  );

  it("captures headers before admission and retains the checkpoint before validation", async () => {
    const source = highlighter();
    const points = source.points;
    const validation = vi.spyOn(replacementValidation, "validateRuntimeReplacementSteps");
    let checks = 0;
    const phases: number[] = [];
    const work = new MutationPreparationScheduler({
      shouldYield: () => {
        checks += 1;
        return checks === 1 || checks === 3;
      },
      yieldControl: async () => {
        phases.push(validation.mock.calls.length);
        source.style = { ...source.style, width: 22 };
        source.points = [0, 0, 0.5];
      },
    });
    const pending = prepareRuntimeElement(source, undefined, undefined, work);
    expect(pending).toBeInstanceOf(Promise);
    expect(validation).not.toHaveBeenCalled();
    const prepared = await pending;
    if (prepared === "cancelled" || prepared.kind !== "stroke") {
      throw new Error("Expected prepared stroke.");
    }
    expect(prepared.style.width).toBe(8);
    expect(prepared.points).toEqual(points);
    expect(prepared.points).not.toBe(points);
    expect(phases).toEqual([0, 0]);
    expect(validation).toHaveBeenCalledTimes(1);
  });

  it("cancels at the staging-to-validation checkpoint without validating or freezing caller data", async () => {
    const source = rectangle();
    const validation = vi.spyOn(replacementValidation, "validateRuntimeReplacementSteps");
    let checks = 0;
    let cancelled = false;
    const work = new MutationPreparationScheduler({
      isCancelled: () => cancelled,
      shouldYield: () => ++checks === 2,
      yieldControl: async () => {
        cancelled = true;
      },
    });
    expect(await prepareRuntimeElement(source, undefined, undefined, work)).toBe("cancelled");
    expect(validation).not.toHaveBeenCalled();
    expect(Object.isFrozen(source)).toBe(false);
  });
});

describe("runtime element preparation failure boundaries", () => {
  it.each([false, true])(
    "keeps schema failures distinct from staging failures (yield: %s)",
    async (yielded) => {
      const work = new MutationPreparationScheduler({
        shouldYield: () => yielded,
        yieldControl: async () => undefined,
      });
      const run = () =>
        prepareRuntimeElement(
          { ...highlighter(), points: [-0, 0, 0.5] },
          undefined,
          undefined,
          work,
        );
      if (yielded) await expect(run()).rejects.toThrow("Invalid runtime element:");
      else expect(run).toThrow("Invalid runtime element:");
    },
  );

  it("normalizes staging input failures before admission without invoking accessors", () => {
    const source = highlighter();
    const getter = vi.fn(() => source.style);
    Object.defineProperty(source, "style", { get: getter, enumerable: true });
    const yieldControl = vi.fn(async () => undefined);
    const work = new MutationPreparationScheduler({ shouldYield: () => true, yieldControl });
    expect(() => prepareRuntimeElement(source, undefined, undefined, work)).toThrow(
      "Invalid runtime element staging.",
    );
    expect(getter).not.toHaveBeenCalled();
    expect(yieldControl).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    "preserves error classification when admission fails at checkpoint %s",
    async (blockedAt) => {
      const error = new TypeError("Central admission failed.");
      let checks = 0;
      const work = new MutationPreparationScheduler({
        shouldYield: () => ++checks === blockedAt,
        yieldControl: () => Promise.reject(error),
      });
      const pending = prepareRuntimeElement(rectangle(), undefined, undefined, work);
      if (blockedAt === 1)
        await expect(pending).rejects.toThrow("Invalid runtime element staging.");
      else await expect(pending).rejects.toBe(error);
    },
  );

  it("propagates unexpected capture errors unchanged", () => {
    const error = new Error("Unexpected capture failure.");
    const source = new Proxy(rectangle(), {
      ownKeys: () => {
        throw error;
      },
    });
    const work = new MutationPreparationScheduler({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    expect(() => prepareRuntimeElement(source, undefined, undefined, work)).toThrow(error);
  });
});
