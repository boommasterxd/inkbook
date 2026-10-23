import { afterEach, expect, it, vi } from "vitest";
import * as bounds from "../../../../../src/domain/geometry/bounds";
import * as validation from "../../../../../src/domain/schema/element-validation";
import {
  prepareInsertionElementSteps,
  preparedInsertionBounds,
} from "../../../../../src/domain/store/mutations/prepared-insertion-element";
import { ElementStore } from "../../../../../src/domain/store/public";
import { MutationPreparationScheduler } from "../../../../../src/domain/store/mutations/mutation-preparation-scheduler";
import { completeSerializationSteps } from "../../../../../src/persistence/serialization/output/serialization-model-preparation";
import { highlighter, rectangle } from "../fixtures";

afterEach(() => vi.restoreAllMocks());
const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };

it("reuses validation and bounds only for the exact immutable staged insertion", async () => {
  const source = highlighter();
  const staged = completeSerializationSteps(prepareInsertionElementSteps(source));
  source.points[0] = 999;
  source.style = { ...source.style, width: 22 };
  expect(staged).not.toEqual(source);
  expect(Object.isFrozen(staged)).toBe(true);
  expect(Object.isFrozen(staged.style)).toBe(true);
  const geometry = vi.spyOn(bounds, "calculateElementBoundsSteps");
  const schema = vi.spyOn(validation, "validateInkElementV1Steps");
  expect(completeSerializationSteps(prepareInsertionElementSteps(staged))).toBe(staged);
  const store = new ElementStore();
  const prepared = await store.prepareElementAppend([staged], scheduler);
  expect(prepared.status).toBe("prepared");
  if (prepared.token === null) throw new Error("Expected insertion.");
  expect(store.commitPreparedElementMutation(prepared.token)).toMatchObject({
    status: "committed",
    transition: { forward: { elements: [staged] } },
  });
  expect(store.get(staged.id)?.element).toBe(staged);
  expect(geometry).not.toHaveBeenCalled();
  expect(schema).not.toHaveBeenCalled();
  expect(preparedInsertionBounds({ ...staged })).toBeUndefined();
  completeSerializationSteps(prepareInsertionElementSteps({ ...staged }));
  expect(geometry).toHaveBeenCalledOnce();
  expect(schema).toHaveBeenCalledOnce();
});

it.each(["id", "points"])("rejects an accessor %s without invoking it", (field) => {
  const source = highlighter();
  const getter = vi.fn(() => source.id);
  Object.defineProperty(source, field, { enumerable: true, get: getter });
  expect(() => completeSerializationSteps(prepareInsertionElementSteps(source))).toThrow(TypeError);
  expect(getter).not.toHaveBeenCalled();
  expect(preparedInsertionBounds(source)).toBeUndefined();
});

it.each([
  () => ({ ...rectangle(), forged: true }),
  () => ({ ...highlighter(), points: [1, 2, Number.NaN] }),
  () => ({ ...highlighter(), points: [1, 2, 2] }),
])("rejects external invalid drafts before publishing an insertion proof", (create) => {
  const draft = create();
  expect(() => completeSerializationSteps(prepareInsertionElementSteps(draft))).toThrow();
  expect(preparedInsertionBounds(draft)).toBeUndefined();
  expect(Object.isFrozen(draft)).toBe(false);
});

it("cancels before producer validation and rejects stale or duplicate append tokens", async () => {
  const draft = highlighter();
  let cancelled = false;
  const work = new MutationPreparationScheduler({
    isCancelled: () => cancelled,
    shouldYield: () => true,
    yieldControl: async () => {
      cancelled = true;
    },
  });
  expect(await work.run(prepareInsertionElementSteps(draft))).toBe("cancelled");
  expect(preparedInsertionBounds(draft)).toBeUndefined();
  expect(Object.isFrozen(draft)).toBe(false);
  const store = new ElementStore();
  await expect(store.prepareElementAppend([draft, draft], scheduler)).rejects.toThrow(
    "unique new element IDs",
  );
  const prepared = await store.prepareElementAppend([draft], scheduler);
  if (prepared.token === null) throw new Error("Expected insertion.");
  store.create([rectangle()]);
  expect(store.commitPreparedElementMutation(prepared.token)).toMatchObject({
    status: "cancelled",
  });
  await expect(store.prepareElementAppend([rectangle()], scheduler)).rejects.toThrow(
    "unique new element IDs",
  );
});
