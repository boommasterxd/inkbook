import { afterEach, describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import { prepareRemovalMutation } from "../../../../../src/domain/store/mutations/removal-mutation";
import * as trustedRemoval from "../../../../../src/domain/store/mutations/trusted-removal-order";
import * as mutationHistory from "../../../../../src/domain/store/mutations/mutation-history";
import { MutationPreparationScheduler } from "../../../../../src/domain/store/mutations/mutation-preparation-scheduler";
import { uninterruptedMutationScheduler as scheduler } from "../../../../fixtures/domain/element-mutation";
import { highlighter, IDS, rectangle } from "../fixtures";

afterEach(() => vi.restoreAllMocks());

function fixture(elements = [rectangle(), rectangle(IDS.other), highlighter()]) {
  const store = new ElementStore(elements);
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

async function removeTargetWithHistory(store: ElementStore) {
  const prepared = await store.prepareElementRemoval([IDS.target], scheduler);
  if (prepared.token === null) throw new Error("Expected removal.");
  const transition = store.commitPreparedElementMutation(prepared.token).transition;
  if (transition === null) throw new Error("Expected retained transition.");
  return transition;
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
        expect(Object.isFrozen(prepared.order.bands[band])).toBe(true);
        expect(prepared.mutation.bands[band]).toBe(prepared.order.bands[band]);
      }
      if (Object.isFrozen(source.bands.highlight)) {
        expect(() => source.bands.highlight.push("later")).toThrow();
      } else source.bands.highlight.push("later");
      expect(prepared.mutation.bands.highlight).not.toContain("later");
    },
  );

  it.each([
    { first: 2, complete: true },
    { first: 4, complete: false },
    { first: 8, complete: false },
  ])(
    "selects complete=$complete for removal at content rank $first while retaining source ranks",
    async ({ first, complete }) => {
      const elements = Array.from({ length: 10 }, (_, index) =>
        rectangle(`00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`),
      );
      const { source } = fixture([...elements, highlighter()]);
      const removed = elements[first]!.id;
      const prepared = await prepareRemovalMutation([removed], source, scheduler);
      if (prepared === null || prepared === "cancelled") throw new Error("Expected removal.");
      expect(prepared.order.ranksComplete).toBe(complete);
      expect(prepared.order.ranks.size).toBe(complete ? 10 : 9 - first);
      if (complete) {
        expect(prepared.order.ranks.get(elements[0]!.id)).toBe(source.ranks.get(elements[0]!.id));
        expect(prepared.order.ranks.get(IDS.highlight)).toBe(source.ranks.get(IDS.highlight));
      } else {
        expect(prepared.order.ranks.has(elements[0]!.id)).toBe(false);
        expect(prepared.order.ranks.has(IDS.highlight)).toBe(false);
      }
      expect(prepared.order.ranks.get(elements[first + 1]!.id)).toEqual({
        band: "content",
        rank: first,
      });
      expect(source.ranks.size).toBe(11);
      expect(source.ranks.get(removed)).toEqual({ band: "content", rank: first });
    },
  );
});

describe("retained removal band ownership", () => {
  it.each(["create-front", "create-back", "arrange", "reorder", "remove"] as const)(
    "copies retained band snapshots before synchronous %s writes",
    async (operation) => {
      const { store } = fixture([
        rectangle(),
        rectangle(IDS.other),
        highlighter(),
        rectangle("00000000-0000-4000-8000-000000000010"),
      ]);
      const transition = await removeTargetWithHistory(store);
      const replay = await store.prepareHistoryReplay(transition.reverse, scheduler, transition);
      if (replay.token === null) throw new Error("Expected restoration.");
      store.commitPreparedElementMutation(replay.token);
      const retained = [...transition.reverse.bands.content];
      if (operation.startsWith("create")) {
        store.create(rectangle("00000000-0000-4000-8000-000000000009"), {
          placement: operation === "create-front" ? "front" : "back",
        });
      } else if (operation === "arrange") {
        store.arrange(new Set([IDS.target]), "bring-to-front");
      } else if (operation === "reorder") {
        store.reorderBands({
          content: [...retained].reverse(),
          highlight: transition.reverse.bands.highlight,
        });
      } else store.remove([IDS.target]);
      expect(transition.reverse.bands.content).toEqual(retained);
      expect(transition.reverse.bands.highlight).toEqual([IDS.highlight]);
      expect(store.materializeBandOrder("content")).not.toEqual(retained);
    },
  );

  it("keeps opaque directions private to their retaining Store and preserves cancellation", async () => {
    const { store } = fixture();
    expect((await store.prepareElementRemoval(["missing"], scheduler)).status).toBe("noop");
    expect(
      (await store.prepareElementRemoval([IDS.target], { ...scheduler, isCancelled: () => true }))
        .status,
    ).toBe("cancelled");
    const transition = await removeTargetWithHistory(store);
    expect(transition.retainedOnly).toBe(true);
    expect(transition.forward.elements).toBeUndefined();
    expect(transition.reverse.elements).toBeUndefined();
    expect(() => store.prepareElementMutation(transition.reverse, scheduler, transition)).toThrow(
      "Opaque history directions",
    );
    await expect(
      new ElementStore().prepareHistoryReplay(transition.reverse, scheduler, transition),
    ).rejects.toThrow("not retained");
    const cancelled = await store.prepareHistoryReplay(
      transition.reverse,
      { ...scheduler, isCancelled: () => true },
      transition,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(store.get(IDS.target)).toBeUndefined();
    const replay = await store.prepareHistoryReplay(transition.reverse, scheduler, transition);
    if (replay.token === null) throw new Error("Expected restoration.");
    store.create(rectangle("00000000-0000-4000-8000-000000000009"));
    expect(store.commitPreparedElementMutation(replay.token).status).toBe("cancelled");
    expect(store.get(IDS.target)).toBeUndefined();
  });
});

describe("removal preparation cancellation", () => {
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

  it.each(["cancelled", "stale"] as const)(
    "abandons a %s retained removal after partial band preparation without publication",
    async (reason) => {
      const { store } = fixture([rectangle(), rectangle(IDS.other), rectangle(IDS.line)]);
      const published = vi.fn();
      store.subscribe(published);
      let checkpoints = 0;
      let cancelled = false;
      const result = await store.prepareElementRemoval([IDS.target], {
        isCancelled: () => cancelled,
        shouldYield: () => ++checkpoints === 3,
        yieldControl: async () => {
          expect(store.get(IDS.target)).toBeDefined();
          expect(published).not.toHaveBeenCalled();
          if (reason === "cancelled") cancelled = true;
          else store.create(rectangle("00000000-0000-4000-8000-000000000009"));
        },
      });
      expect(result).toEqual({ status: "cancelled", token: null });
      expect(store.get(IDS.target)).toBeDefined();
      expect(published).toHaveBeenCalledTimes(reason === "stale" ? 1 : 0);
      expect(store.materializeBandOrder("content").slice(0, 2)).toEqual([IDS.target, IDS.other]);
    },
  );

  it("rejects cancellation after retained history preparation before publishing a token", async () => {
    const { store } = fixture();
    const prepare = mutationHistory.prepareMutationHistory;
    let cancelled = false;
    vi.spyOn(mutationHistory, "prepareMutationHistory").mockImplementation(async (...args) => {
      const result = await prepare(...args);
      cancelled = true;
      return result;
    });
    const result = await store.prepareElementRemoval([IDS.target], {
      ...scheduler,
      isCancelled: () => cancelled,
    });
    expect(result).toEqual({ status: "cancelled", token: null });
    expect(store.get(IDS.target)).toBeDefined();
    expect(store.size).toBe(3);
  });
});

describe("trusted removal lifecycle", () => {
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
