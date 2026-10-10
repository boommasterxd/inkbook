import { describe, expect, it, vi } from "vitest";

import * as renderBands from "../../../../src/domain/commands/render-bands";
import { restoreOwnedReplayBands } from "../../../../src/domain/store/mutation-order";
import {
  captureOwnedMutationHistory,
  STABLE_RELATIVE_ORDER,
} from "../../../../src/domain/store/owned-mutation-history";
import { MutationPreparationScheduler } from "../../../../src/domain/store/mutation-preparation-scheduler";
import {
  ElementStore,
  type AppliedElementMutation,
  type ElementMutation,
} from "../../../../src/domain/store/public";
import { highlighter, IDS, rectangle } from "./fixtures";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
const rectangles = () => [rectangle(), rectangle(IDS.other), rectangle(IDS.line)];
const bands = (store: ElementStore) => ({
  content: store.materializeBandOrder("content"),
  highlight: store.materializeBandOrder("highlight"),
});

async function apply(
  store: ElementStore,
  mutation: ElementMutation,
  replay?: AppliedElementMutation,
) {
  const prepared = await store.prepareElementMutation(mutation, scheduler, replay);
  if (prepared.token === null) throw new Error("Expected prepared mutation.");
  const result = store.commitPreparedElementMutation(prepared.token);
  if (result.transition === null || result.delta === null)
    throw new Error("Expected committed mutation.");
  return result as typeof result & {
    transition: AppliedElementMutation;
    delta: NonNullable<typeof result.delta>;
  };
}

describe("structural membership order deltas", () => {
  it.each(["tail", "all"])("marks %s removal dirty without survivor deltas", (scope) => {
    const elements = rectangles();
    const store = new ElementStore([...elements, highlighter()]);
    const ids = scope === "all" ? elements.map(({ id }) => id) : [elements[2]!.id];
    const delta = store.remove(ids)!;
    expect(delta.dirtyBands).toEqual({ content: true, highlight: false });
    expect(delta.changes.map(({ id }) => id)).toEqual(ids);
    expect(store.materializeBandOrder("highlight")).toEqual([IDS.highlight]);
  });

  it("publishes only removed and restored membership while keeping dense survivor ranks", async () => {
    const elements = rectangles();
    const store = new ElementStore(elements);
    const first = elements[0]!.id;
    const removed = await apply(store, {
      bands: { content: elements.slice(1).map(({ id }) => id), highlight: [] },
      removeIds: [first],
    });
    expect(removed.delta.changes.map(({ id }) => id)).toEqual([first]);
    expect(store.getRank(elements[2]!.id)).toEqual({ band: "content", rank: 1 });
    const restored = await apply(store, removed.transition.reverse, removed.transition);
    expect(restored.delta.changes.map(({ id }) => id)).toEqual([first]);
    expect(store.getRank(elements[2]!.id)).toEqual({ band: "content", rank: 2 });
    const redone = await apply(store, removed.transition.forward, removed.transition);
    expect(redone.delta.changes.map(({ id }) => id)).toEqual([first]);
  });

  it("keeps complete order semantics when removal also reorders survivors", async () => {
    const elements = rectangles();
    const store = new ElementStore(elements);
    const result = await apply(store, {
      bands: { content: [elements[2]!.id, elements[1]!.id], highlight: [] },
      removeIds: [elements[0]!.id],
    });
    expect(result.delta.changes.find(({ id }) => id === elements[2]!.id)?.domains).toEqual([
      "order",
    ]);
    expect(result.delta.dirtyBands.content).toBe(true);
    await apply(store, result.transition.reverse, result.transition);
    expect(bands(store).content).toEqual(elements.map(({ id }) => id));
    await apply(store, result.transition.forward, result.transition);
    expect(bands(store).content).toEqual([elements[2]!.id, elements[1]!.id]);
  });
});

describe("private replay band proof", () => {
  it("skips unaffected band validation only for current exact owned directions", async () => {
    const elements = rectangles();
    const store = new ElementStore([...elements, highlighter()]);
    const removed = store.removeWithHistory([elements[0]!.id])!;
    const bandCheck = vi.spyOn(renderBands, "renderBandOf");
    try {
      await apply(store, removed.transition.reverse, removed.transition);
      expect(
        bandCheck.mock.calls.some(([element]) => "id" in element && element.id === IDS.highlight),
      ).toBe(false);
      bandCheck.mockClear();
      await apply(store, removed.transition.forward, removed.transition);
      expect(
        bandCheck.mock.calls.some(([element]) => "id" in element && element.id === IDS.highlight),
      ).toBe(false);
      store.updateStyle(elements[1]!.id, { ...elements[1]!.style, outlineOpacity: 0.5 });
      bandCheck.mockClear();
      await apply(store, removed.transition.reverse, removed.transition);
      expect(
        bandCheck.mock.calls.some(([element]) => "id" in element && element.id === IDS.highlight),
      ).toBe(true);
    } finally {
      bandCheck.mockRestore();
    }
    // The adopted unchanged band remains writable by later ordinary insertions.
    store.create({ ...highlighter(), id: "00000000-0000-4000-8000-000000000090" });
    expect(store.materializeBandOrder("highlight")).toHaveLength(2);
  });

  it("fully validates public element mutations instead of trusting frozen direction arrays", async () => {
    const elements = rectangles();
    const store = new ElementStore([...elements, highlighter()]);
    const removed = store.removeWithHistory([elements[0]!.id])!;
    const retained = removed.transition.reverse.elements![0]!;
    if (retained.kind !== "rectangle") throw new Error("Expected retained rectangle.");
    Object.assign(retained.style, { outlineOpacity: 0.5 });
    const bandCheck = vi.spyOn(renderBands, "renderBandOf");
    try {
      await apply(store, removed.transition.reverse, removed.transition);
      expect(
        bandCheck.mock.calls.some(([element]) => "id" in element && element.id === IDS.highlight),
      ).toBe(true);
    } finally {
      bandCheck.mockRestore();
    }
  });

  it("does not admit frozen foreign directions or unfrozen cloned directions", async () => {
    const elements = rectangles();
    const owner = new ElementStore([...elements, highlighter()]);
    const removed = owner.removeWithHistory([elements[0]!.id])!;
    const other = new ElementStore([...elements.slice(1), highlighter()]);
    const bandCheck = vi.spyOn(renderBands, "renderBandOf");
    try {
      await apply(other, removed.transition.reverse, removed.transition);
      expect(
        bandCheck.mock.calls.some(([element]) => "id" in element && element.id === IDS.highlight),
      ).toBe(true);
      bandCheck.mockClear();
      await apply(owner, { ...removed.transition.reverse });
      expect(
        bandCheck.mock.calls.some(([element]) => "id" in element && element.id === IDS.highlight),
      ).toBe(true);
    } finally {
      bandCheck.mockRestore();
    }
  });
});

describe("replay order cancellation and misuse", () => {
  it("rejects altered public membership before installing the retained order", async () => {
    const elements = rectangles();
    const store = new ElementStore(elements);
    const removed = store.removeWithHistory([elements[0]!.id])!;
    removed.transition.reverse.elements![0]!.id = "00000000-0000-4000-8000-000000000099";
    await expect(
      store.prepareElementMutation(removed.transition.reverse, scheduler, removed.transition),
    ).rejects.toThrow("exactly once");
    expect(bands(store).content).toEqual(elements.slice(1).map(({ id }) => id));
    expect(store.instrumentation.publishedDeltas).toBe(1);
  });

  it("cancels retained-band copying without changing source arrays", async () => {
    const elements = rectangles();
    const store = new ElementStore(elements);
    const removed = store.removeWithHistory([elements[0]!.id])!;
    const sourceBands = { content: [...store.materializeBandOrder("content")], highlight: [] };
    let cancelled = false;
    expect(
      await restoreOwnedReplayBands(
        removed.transition.reverse.bands,
        { bands: sourceBands, records: new Map() },
        new Map(),
        captureOwnedMutationHistory(removed.delta, STABLE_RELATIVE_ORDER),
        new MutationPreparationScheduler({
          isCancelled: () => cancelled,
          shouldYield: () => true,
          yieldControl: async () => {
            cancelled = true;
          },
        }),
      ),
    ).toBe("cancelled");
    expect(sourceBands.content).toEqual(elements.slice(1).map(({ id }) => id));
  });
});
