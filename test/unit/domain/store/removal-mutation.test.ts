import { afterEach, describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { prepareRemovalMutation } from "../../../../src/domain/store/removal-mutation";
import * as trustedRemoval from "../../../../src/domain/store/trusted-removal-order";
import { MutationPreparationScheduler } from "../../../../src/domain/store/mutation-preparation-scheduler";
import { uninterruptedMutationScheduler as scheduler } from "../../../fixtures/domain/element-mutation";
import { highlighter, IDS, rectangle } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const store = new ElementStore([rectangle(), rectangle(IDS.other), highlighter()]);
  const bands = {
    content: [...store.materializeBandOrder("content")],
    highlight: [...store.materializeBandOrder("highlight")],
  };
  const ids = [...bands.content, ...bands.highlight];
  return {
    store,
    source: {
      bands,
      ranks: new Map(ids.map((id) => [id, store.getRank(id)!])),
      records: new Map(ids.map((id) => [id, store.get(id)!])),
    },
  };
}

describe("private removal order preparation", () => {
  it.each([[IDS.target], [IDS.target, IDS.highlight]])(
    "prepares affected bands while isolating the public mutation (%j)",
    async (...ids: [string, ...string[]]) => {
      const { source } = fixture();
      const prepared = await prepareRemovalMutation([...ids, ids[0], "missing"], source, scheduler);
      if (prepared === null || prepared === "cancelled") throw new Error("Expected removal.");
      expect(prepared.mutation.removeIds).toEqual(ids);
      expect(prepared.order.bands.content).toEqual([IDS.other]);
      expect(prepared.order.ranks.get(IDS.other)).toEqual({ band: "content", rank: 0 });
      expect(prepared.order.relativeOrderPreserved).toEqual({ content: true, highlight: true });
      expect(prepared.order.dirtyBands.highlight).toBe(ids.includes(IDS.highlight));
      expect(prepared.order.bands.highlight === source.bands.highlight).toBe(
        !ids.includes(IDS.highlight),
      );
      for (const band of ["content", "highlight"] as const) {
        expect(Object.isFrozen(prepared.mutation.bands[band])).toBe(true);
        expect(Object.isFrozen(prepared.order.bands[band])).toBe(false);
        expect(prepared.mutation.bands[band]).not.toBe(prepared.order.bands[band]);
      }
      source.bands.highlight.push("later");
      expect(prepared.mutation.bands.highlight).not.toContain("later");
    },
  );

  it("returns no mutation for absent IDs and cancels without changing source state", async () => {
    const { source } = fixture();
    expect(await prepareRemovalMutation(["missing"], source, scheduler)).toBeNull();
    let cancelled = false;
    expect(
      await prepareRemovalMutation([IDS.target], source, {
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          cancelled = true;
        },
      }),
    ).toBe("cancelled");
    expect(source.bands).toEqual({ content: [IDS.target, IDS.other], highlight: [IDS.highlight] });
    expect(source.records.size).toBe(3);
  });

  it("reuses unaffected authoritative bands in the trusted fallback", async () => {
    const { source } = fixture();
    const order = await trustedRemoval.validateTrustedRemovalOrder(
      { bands: { content: [], highlight: [] }, removeIds: [IDS.highlight] },
      source,
      source.ranks,
      new Set([IDS.highlight]),
      new MutationPreparationScheduler(scheduler),
    );
    if (order === "cancelled") throw new Error("Expected removal order.");
    expect(order.bands.content).toBe(source.bands.content);
    expect(order.bands.highlight).toEqual([]);
    expect(order.dirtyBands).toEqual({ content: false, highlight: true });
  });

  it("uses the registered private order and cancels a stale prepared commit", async () => {
    const { store } = fixture();
    const mutation = await store.createRemovalMutationTimeSliced([IDS.target], scheduler);
    if (mutation === null || mutation === "cancelled") throw new Error("Expected removal.");
    const fallback = vi.spyOn(trustedRemoval, "validateTrustedRemovalOrder");
    const prepared = await store.prepareElementMutation(mutation, scheduler);
    if (prepared.token === null) throw new Error("Expected prepared token.");
    expect(fallback).not.toHaveBeenCalled();
    expect((await store.prepareElementMutation(mutation, scheduler)).status).toBe("prepared");
    expect(fallback).toHaveBeenCalledTimes(1);
    store.create(rectangle("00000000-0000-4000-8000-000000000009"));
    expect(store.commitPreparedElementMutation(prepared.token).status).toBe("cancelled");
    expect(store.get(IDS.target)).toBeDefined();
  });

  it("commits once, shares unchanged history bands and fully validates a stale removal mutation", async () => {
    const { store } = fixture();
    const mutation = await store.createRemovalMutationTimeSliced([IDS.target], scheduler);
    if (mutation === null || mutation === "cancelled") throw new Error("Expected removal.");
    const prepared = await store.prepareElementMutation(mutation, scheduler);
    if (prepared.token === null) throw new Error("Expected prepared token.");
    const committed = store.commitPreparedElementMutation(prepared.token);
    expect(committed.status).toBe("committed");
    expect(committed.delta?.dirtyBands).toEqual({ content: true, highlight: false });
    expect(committed.transition?.reverse.bands.highlight).toBe(
      committed.transition?.forward.bands.highlight,
    );
    expect(store.commitPreparedElementMutation(prepared.token).status).toBe("cancelled");
    expect(store.get(IDS.target)).toBeUndefined();
    const next = await store.createRemovalMutationTimeSliced([IDS.other], scheduler);
    if (next === null || next === "cancelled") throw new Error("Expected removal.");
    store.create(rectangle("00000000-0000-4000-8000-000000000009"));
    await expect(store.prepareElementMutation(next, scheduler)).rejects.toThrow("exactly once");
    expect(store.get(IDS.other)).toBeDefined();
  });
});
