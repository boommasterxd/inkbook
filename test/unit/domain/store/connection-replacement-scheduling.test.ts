import { expect, it } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { prepareReplacementCandidatesTimeSliced } from "../../../../src/domain/store/replacement-planner";
import type { StoreSliceScheduler } from "../../../../src/domain/store/types";
import { connectionChain } from "../../../fixtures/domain/connection-chain";

const uninterrupted: StoreSliceScheduler = {
  shouldYield: () => false,
  yieldControl: async () => {
    throw new Error("Unexpired work must not yield.");
  },
};

it("keeps synchronous paint changes and rejects synchronous cycles atomically", () => {
  const elements = connectionChain(8);
  const store = new ElementStore(elements);
  const first = elements[0]!;
  const last = elements[elements.length - 1]!;
  const beforeFirst = store.get(first.id);

  expect(
    store.replace(last.id, { ...last, style: { ...last.style, outlineOpacity: 0.5 } }),
  ).toMatchObject({ changes: [{ id: last.id, domains: ["paint"] }] });
  expect(() =>
    store.replace(first.id, {
      ...first,
      startConnection: { ...last.startConnection!, targetId: last.id },
    }),
  ).toThrow("must not form a cycle");
  expect(store.get(first.id)).toBe(beforeFirst);
  expect(store.instrumentation.publishedDeltas).toBe(1);
});

it("rejects a cycle after yielding through the reachable graph without publishing", async () => {
  const elements = connectionChain(256);
  const store = new ElementStore(elements);
  const first = elements[0]!;
  const last = elements[elements.length - 1]!;
  const before = store.get(first.id);
  let checkpoints = 0;
  let yields = 0;

  await expect(
    store.prepareElementReplacement(
      [{ ...first, startConnection: { ...last.startConnection!, targetId: last.id } }],
      {
        shouldYield: () => ++checkpoints % 32 === 0,
        yieldControl: async () => {
          yields += 1;
          expect(store.get(first.id)).toBe(before);
        },
      },
    ),
  ).rejects.toThrow("must not form a cycle");
  expect(yields).toBeGreaterThan(1);
  expect(store.get(first.id)).toBe(before);
  expect(store.instrumentation.publishedDeltas).toBe(0);
});

it("cancels graph traversal and later prepares and commits an unchanged-edge paint change", async () => {
  const elements = connectionChain(256);
  const store = new ElementStore(elements);
  const last = elements[elements.length - 1]!;
  const before = store.get(last.id);
  const replacement = { ...last, style: { ...last.style, outlineOpacity: 0.5 } };
  let cancelled = false;
  let ancestorReads = 0;
  const abandoned = await prepareReplacementCandidatesTimeSliced(
    [replacement],
    {
      getRecord: (id) => {
        if (id !== last.id && id !== elements[elements.length - 2]!.id) ancestorReads += 1;
        return store.get(id)!;
      },
      getReferences: () => undefined,
      onReverseVisit: () => undefined,
    },
    {
      isCancelled: () => cancelled,
      shouldYield: () => ancestorReads === 32,
      yieldControl: async () => {
        cancelled = true;
      },
    },
  );

  expect(abandoned).toBe("cancelled");
  expect(ancestorReads).toBe(32);
  expect(store.get(last.id)).toBe(before);
  expect(store.instrumentation.publishedDeltas).toBe(0);
  const prepared = await store.prepareElementReplacement([replacement], uninterrupted);
  if (prepared.token === null) throw new Error("Expected a prepared replacement.");
  expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");
  expect(store.get(last.id)?.element.style).toMatchObject({ outlineOpacity: 0.5 });
  expect(store.instrumentation.publishedDeltas).toBe(1);
});

it("preserves missing-target and invalid-anchor rejection on the sliced path", async () => {
  const [first, last] = connectionChain(2);
  if (first === undefined || last === undefined) throw new Error("Expected connected lines.");
  const store = new ElementStore([first, last]);
  const before = store.get(last.id);
  await expect(
    store.prepareElementReplacement(
      [{ ...last, startConnection: { ...last.startConnection!, targetId: "missing" } }],
      uninterrupted,
    ),
  ).rejects.toThrow(RangeError);
  await expect(
    store.prepareElementReplacement(
      [
        {
          ...last,
          startConnection: {
            targetId: first.id,
            anchor: { kind: "box", position: "top-left" },
          },
        },
      ],
      uninterrupted,
    ),
  ).rejects.toThrow("connection anchor is invalid");
  expect(store.get(last.id)).toBe(before);
  expect(store.instrumentation.publishedDeltas).toBe(0);
});

it("does not treat unchanged edges in an unproven input graph as an acyclic proof", async () => {
  const [first, last] = connectionChain(2);
  if (first === undefined || last === undefined) throw new Error("Expected connected lines.");
  const store = new ElementStore([
    { ...first, startConnection: { ...last.startConnection!, targetId: last.id } },
    last,
  ]);
  await expect(
    store.prepareElementReplacement(
      [{ ...last, style: { ...last.style, outlineOpacity: 0.5 } }],
      uninterrupted,
    ),
  ).rejects.toThrow("must not form a cycle");
  expect(store.instrumentation.publishedDeltas).toBe(0);
});
