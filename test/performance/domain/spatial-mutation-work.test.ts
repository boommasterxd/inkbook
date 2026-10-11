import { expect, it, vi } from "vitest";

import * as bottomHeap from "../../../src/domain/spatial/max-bottom-heap";
import { SpatialQueryScratch, UniformSpatialIndex } from "../../../src/domain/spatial/index";

const ELEMENT_COUNT = 10_000;
const SLICE_WORK = 64;
// One admitted sift compares at most two children per level of the maximum-size heap.
const MAX_SLICE_WORK = SLICE_WORK + 2 * Math.ceil(Math.log2(ELEMENT_COUNT));
const bounds = (id: number) => ({
  minX: id * 256 + 1,
  maxX: id * 256 + 2,
  minY: id * 256 + 1,
  maxY: id * 256 + 2,
});
const insertions = Array.from({ length: ELEMENT_COUNT }, (_, id) => ({ id, bounds: bounds(id) }));

function observeMutationWork(index: UniformSpatialIndex<number>) {
  const entries = (index as unknown as { entries: Map<number, unknown> }).entries;
  const originalGet = entries.get.bind(entries);
  const originalValues = entries.values.bind(entries);
  const sift = bottomHeap.heapifyBottomAt;
  let sliceWork = 0;
  let comparisons = 0;
  let enumerations = 0;
  let yields = 0;
  const get = vi.spyOn(entries, "get").mockImplementation((id) => {
    sliceWork += 1;
    return originalGet(id);
  });
  const values = vi.spyOn(entries, "values").mockImplementation(function* () {
    for (const entry of originalValues()) {
      sliceWork += 1;
      enumerations += 1;
      yield entry;
    }
    return undefined;
  });
  const prototype = UniformSpatialIndex.prototype as unknown as {
    attachEntry: (...args: unknown[]) => void;
  };
  const originalAttach = prototype.attachEntry;
  const attach = vi.spyOn(prototype, "attachEntry").mockImplementation(function (
    this: object,
    ...args
  ) {
    sliceWork += 1;
    originalAttach.apply(this, args);
  });
  const heapify = vi.spyOn(bottomHeap, "heapifyBottomAt").mockImplementation((heap, offset) => {
    const work = sift(heap, offset);
    comparisons += work;
    sliceWork += work;
    return work;
  });
  const push = vi.spyOn(bottomHeap, "pushBottom");
  const liveSize = index.size;
  return {
    attach,
    get,
    heapify,
    push,
    values,
    counts: () => ({
      attaches: attach.mock.calls.length,
      comparisons,
      enumerations,
      heapBuilds: heapify.mock.calls.length,
      pushes: push.mock.calls.length,
      sliceWork,
      yields,
    }),
    scheduler: {
      shouldYield: () => sliceWork >= SLICE_WORK,
      yieldControl: async () => {
        expect(sliceWork).toBeLessThanOrEqual(MAX_SLICE_WORK);
        expect(index.size).toBe(liveSize);
        sliceWork = 0;
        yields += 1;
      },
    },
    restore: () => {
      for (const spy of [get, values, attach, heapify, push]) spy.mockRestore();
    },
  };
}

it("builds the retained spatial shadow with linear heap comparisons before atomic publication", async () => {
  const index = new UniformSpatialIndex<number>();
  index.insertMany(insertions);
  const observed = observeMutationWork(index);
  const scratch = new SpatialQueryScratch<number>();
  const oldCursor = index.beginQuery(bounds(0));
  try {
    const prepared = await index.prepareMutationTimeSliced(
      Array.from({ length: ELEMENT_COUNT / 2 }, (_, id) => id),
      [],
      observed.scheduler,
    );
    if (prepared === "cancelled") throw new Error("Expected a prepared spatial cut.");
    expect(observed.counts().yields).toBeGreaterThan(0);
    expect(observed.counts().sliceWork).toBeLessThanOrEqual(MAX_SLICE_WORK);
    expect(observed.counts().enumerations).toBe(ELEMENT_COUNT);
    expect(observed.get).toHaveBeenCalledTimes(ELEMENT_COUNT / 2);
    expect(observed.values).toHaveBeenCalledTimes(1);
    expect(observed.attach).toHaveBeenCalledTimes(ELEMENT_COUNT / 2);
    expect(observed.heapify).toHaveBeenCalledTimes(ELEMENT_COUNT / 4);
    expect(observed.counts().comparisons).toBeGreaterThan(ELEMENT_COUNT / 2);
    expect(observed.counts().comparisons).toBeLessThanOrEqual(ELEMENT_COUNT);
    expect(observed.push).not.toHaveBeenCalled();
    expect(index.query(bounds(0), scratch)).toBe(1);
    const workBeforeCommit = observed.counts();
    prepared.commit();
    expect(observed.counts()).toEqual(workBeforeCommit);
    expect(() => prepared.commit()).toThrow("stale");
    expect(index.size).toBe(ELEMENT_COUNT / 2);
    expect(index.membershipCount).toBe(ELEMENT_COUNT / 2);
    expect(index.extentHeapEntryCount).toBe(ELEMENT_COUNT / 2);
    expect(index.query(bounds(0), scratch)).toBe(0);
    expect(index.query(bounds(ELEMENT_COUNT - 1), scratch)).toBe(1);
    expect(index.getMaximumBottom()).toBe(bounds(ELEMENT_COUNT - 1).maxY);
    expect(oldCursor.advance(1).stale).toBe(true);
    expect((index as unknown as { slots: readonly unknown[] }).slots.length).toBe(
      ELEMENT_COUNT / 2,
    );
  } finally {
    observed.restore();
  }
});

it("clears 10,000 validated entries without a second enumeration and restores the linear heap", async () => {
  const index = new UniformSpatialIndex<number>();
  index.insertMany(insertions);
  const observedClear = observeMutationWork(index);
  try {
    const cleared = await index.prepareMutationTimeSliced(
      insertions.map(({ id }) => id),
      [],
      observedClear.scheduler,
    );
    if (cleared === "cancelled") throw new Error("Expected a prepared full clear.");
    expect(observedClear.get).toHaveBeenCalledTimes(ELEMENT_COUNT);
    expect(observedClear.values).not.toHaveBeenCalled();
    expect(observedClear.counts().enumerations).toBe(0);
    expect(observedClear.heapify).not.toHaveBeenCalled();
    expect(observedClear.push).not.toHaveBeenCalled();
    cleared.commit();
    expect(index.size).toBe(0);
    expect(index.membershipCount).toBe(0);
    expect(index.extentHeapEntryCount).toBe(0);
    expect(index.getMaximumBottom()).toBeUndefined();
  } finally {
    observedClear.restore();
  }
  const observedRestore = observeMutationWork(index);
  try {
    const restored = await index.prepareMutationTimeSliced(
      [],
      insertions,
      observedRestore.scheduler,
    );
    if (restored === "cancelled") throw new Error("Expected a prepared restore.");
    expect(observedRestore.attach).toHaveBeenCalledTimes(ELEMENT_COUNT);
    expect(observedRestore.heapify).toHaveBeenCalledTimes(ELEMENT_COUNT / 2);
    expect(observedRestore.counts().comparisons).toBeGreaterThan(ELEMENT_COUNT);
    expect(observedRestore.counts().comparisons).toBeLessThanOrEqual(2 * ELEMENT_COUNT);
    expect(observedRestore.counts().sliceWork).toBeLessThanOrEqual(MAX_SLICE_WORK);
    expect(observedRestore.push).not.toHaveBeenCalled();
    const workBeforeCommit = observedRestore.counts();
    restored.commit();
    expect(observedRestore.counts()).toEqual(workBeforeCommit);
    expect(index.size).toBe(ELEMENT_COUNT);
    expect(index.extentHeapEntryCount).toBe(ELEMENT_COUNT);
    expect(index.getMaximumBottom()).toBe(bounds(ELEMENT_COUNT - 1).maxY);
  } finally {
    observedRestore.restore();
  }
});
