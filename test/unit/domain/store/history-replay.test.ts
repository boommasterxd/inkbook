import { describe, expect, it, vi } from "vitest";

import { DEFAULT_HISTORY_BYTE_LIMIT } from "../../../../src/domain/commands/history";
import * as payload from "../../../../src/domain/store/mutation-payload";
import {
  ElementStore,
  type AppliedElementMutation,
  type ElementMutation,
} from "../../../../src/domain/store/public";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";
import { highlighter } from "./fixtures";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };

async function removedStroke() {
  const source = highlighter();
  const { store } = await hydrateRuntimeStroke(source);
  const transition = await apply(store, {
    bands: { content: [], highlight: [] },
    removeIds: [source.id],
  });
  return { source, store, transition };
}

async function apply(
  store: ElementStore,
  mutation: ElementMutation,
  replay?: AppliedElementMutation,
) {
  const prepared = await store.prepareElementMutation(mutation, scheduler, replay);
  if (prepared.token === null) throw new Error("Expected prepared mutation.");
  const result = store.commitPreparedElementMutation(prepared.token);
  if (result.transition === null) throw new Error("Expected applied mutation.");
  return result.transition;
}

describe("validated history replay", () => {
  it("reuses the retained transition through Undo and Redo", async () => {
    const { store, source, transition } = await removedStroke();
    expect(await apply(store, transition.reverse, transition)).toBe(transition);
    expect(store.get(source.id)?.element).toMatchObject({
      id: source.id,
      points: new Float64Array(source.points),
    });
    expect(await apply(store, transition.forward, transition)).toBe(transition);
    expect(store.size).toBe(0);
    expect(store.instrumentation.publishedDeltas).toBe(3);
  });

  it("rejects unrelated requests paired with a replay transition", async () => {
    const { store, transition } = await removedStroke();
    await expect(
      store.prepareElementMutation({ ...transition.reverse }, scheduler, transition),
    ).rejects.toThrow("retained transition direction");
    expect(store.size).toBe(0);
  });

  it("validates retained runtime samples again before restoring them", async () => {
    const { store, transition } = await removedStroke();
    const restored = transition.reverse.elements![0]!;
    if (restored.kind !== "stroke") throw new Error("Expected stroke.");
    restored.points[0] = Number.NaN;
    await expect(
      store.prepareElementMutation(transition.reverse, scheduler, transition),
    ).rejects.toThrow(RangeError);
    expect(store.size).toBe(0);
  });

  it("rechecks payload limits instead of trusting retained metadata", async () => {
    const { store, transition } = await removedStroke();
    const estimate = vi
      .spyOn(payload, "elementMutationPayloadBytes")
      .mockReturnValue(DEFAULT_HISTORY_BYTE_LIMIT);
    try {
      await expect(
        store.prepareElementMutation(transition.reverse, scheduler, transition),
      ).rejects.toThrow("retained history payload limit");
      expect(store.size).toBe(0);
    } finally {
      estimate.mockRestore();
    }
  });

  it("cancels a replay during preparation without publication", async () => {
    const { store, transition } = await removedStroke();
    let cancelled = false;
    const result = await store.prepareElementMutation(
      transition.reverse,
      {
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          cancelled = true;
        },
      },
      transition,
    );
    expect(result.status).toBe("cancelled");
    expect(store.size).toBe(0);
    expect(store.instrumentation.publishedDeltas).toBe(1);
  });
});
