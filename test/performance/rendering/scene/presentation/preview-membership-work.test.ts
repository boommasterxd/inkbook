import { afterEach, expect, it, vi } from "vitest";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import {
  createLongPreviewStroke,
  createProgressivePreviewFixture,
  writeOnePreviewStep,
} from "../../../../fixtures/rendering/progressive-element-preview";
import { indexedStroke } from "../../../../fixtures/editor/stroke";

afterEach(() => vi.restoreAllMocks());

/** Count actual selection entry reads, including native Array.includes comparisons. */
function observeSelectionReads(ids: readonly string[]) {
  let reads = 0;
  return {
    ids: new Proxy(ids, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        const value: unknown = Reflect.get(target, key, receiver);
        return value;
      },
    }),
    reads: () => reads,
    reset: () => (reads = 0),
  };
}

it.each([1_000, 10_000])(
  "reuses %s feedback members across 256 snapshots, pressure work and remount batches",
  (count) => {
    const { preview, content } = createProgressivePreviewFixture();
    const ids = Array.from({ length: count }, (_, index) => indexedStroke(index).id);
    const observed = observeSelectionReads(ids);
    const element = createLongPreviewStroke(0);
    let time = 0;
    const materialize = vi.fn(() => {
      time = 1;
      return element;
    });
    const request = {
      ids: ids.slice(0, 256),
      feedbackIds: observed.ids,
      materialize,
      feedback: { transform: "scale(2 1)", inverse: "scale(0.5 1)" },
    };
    preview.set({ ...request, version: 1 });
    expect(observed.reads()).toBe(count);
    expect(preview.write(1, () => time)).toBe(true);
    expect(materialize).toHaveBeenCalledOnce();
    expect(preview.values.size).toBe(0);
    observed.reset();
    for (const version of [2, 3, 4]) preview.set({ ...request, version });
    expect(observed.reads()).toBe(0);
    for (let start = 0; start < count; start += 64)
      preview.applyMounted([...ids.slice(start, start + 64), "foreign"]);
    expect(observed.reads()).toBe(0);
    expect(content.applyPreviewTransform).toHaveBeenCalledTimes(count);
    expect(preview.transforms.size).toBe(count);
    const bytes = preview.memoryUsage();
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
    preview.applyMounted(ids);
    expect(observed.reads()).toBe(0);
    expect(content.applyPreviewTransform).toHaveBeenCalledTimes(count * 2);
    expect(preview.memoryUsage()).toBe(bytes);
    expect(materialize).toHaveBeenCalledOnce();
    preview.release();
    expect(preview.memoryUsage()).toBe(0);
    content.applyPreviewTransform.mockClear();
    preview.applyMounted(ids);
    expect(content.applyPreviewTransform).not.toHaveBeenCalled();
    expect(observed.reads()).toBe(0);
  },
);

it("replaces changed membership and drops removed pending paths before the next mount", () => {
  const { preview, content } = createProgressivePreviewFixture();
  const element = createLongPreviewStroke(0);
  const feedback = { transform: "scale(2 1)", inverse: "scale(0.5 1)" };
  const initial = observeSelectionReads([element.id, "retained", "removed", "retained"]);
  preview.set({
    ids: [element.id],
    feedbackIds: initial.ids,
    materialize: () => element,
    version: 1,
    feedback,
  });
  writeOnePreviewStep(preview);
  preview.applyMounted(initial.ids);
  expect(preview.transforms.size).toBe(3);
  const cancel = vi.spyOn(ProgressivePreviewPath.prototype, "cancel");
  const next = observeSelectionReads(["retained", "added"]);
  preview.set({
    ids: [],
    feedbackIds: next.ids,
    materialize: () => undefined,
    version: 2,
    feedback,
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(next.reads()).toBe(2);
  next.reset();
  content.applyPreviewTransform.mockClear();
  preview.applyMounted([element.id, "retained", "removed", "added", "foreign"]);
  expect(content.applyPreviewTransform.mock.calls.map(([id]) => id)).toEqual(["retained", "added"]);
  expect(next.reads()).toBe(0);
  expect(preview.transforms.size).toBe(2);
  expect(preview.pending).toBe(false);
  preview.clear();
  expect(preview.memoryUsage()).toBe(0);
  preview.set({
    ids: [],
    feedbackIds: next.ids,
    materialize: () => undefined,
    version: 3,
    feedback,
  });
  expect(next.reads()).toBe(2);
  preview.release();
  expect(preview.memoryUsage()).toBe(0);
});
