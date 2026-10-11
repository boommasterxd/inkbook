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

it("bounds marker allocation and eliminates copies while an indexed 10K document grows", () => {
  const MarkerArray = Uint32Array;
  let allocatedBytes = 0;
  let allocations = 0;
  const construct = new Proxy(MarkerArray, {
    construct(target, args, newTarget) {
      const array = Reflect.construct(target, args, newTarget) as Uint32Array;
      if (array.byteLength !== 0) {
        allocatedBytes += array.byteLength;
        allocations += 1;
      }
      return array;
    },
  });
  const copy = vi.spyOn(MarkerArray.prototype, "set");
  let copiedBytes = 0;
  vi.stubGlobal("Uint32Array", construct);
  const index = new UniformSpatialIndex<number>();
  const scratch = new SpatialQueryScratch<number>();
  try {
    for (const { id, bounds: entryBounds } of insertions) {
      index.insert(id, entryBounds);
      expect(index.query(entryBounds, scratch)).toBe(1);
      expect(scratch.at(0)).toBe(id);
      for (const [source] of copy.mock.calls) copiedBytes += source.length * 4;
      copy.mockClear();
    }
    // Starting at 16 slots, doubling reaches 16,384 in eleven allocations.
    expect(allocations).toBeLessThanOrEqual(11);
    expect(allocatedBytes).toBeLessThanOrEqual(ELEMENT_COUNT * 16);
    expect(copiedBytes).toBe(0);
    expect(scratch.markerCapacity).toBeGreaterThanOrEqual(ELEMENT_COUNT);
    expect(scratch.markerCapacity).toBeLessThan(ELEMENT_COUNT * 2);
    const warmed = { allocations, allocatedBytes };
    expect(index.remove(ELEMENT_COUNT - 1)).toBe(true);
    index.insert(ELEMENT_COUNT, bounds(ELEMENT_COUNT - 1));
    expect(index.query(bounds(ELEMENT_COUNT - 1), scratch)).toBe(1);
    expect(scratch.at(0)).toBe(ELEMENT_COUNT);
    expect({ allocations, allocatedBytes }).toEqual(warmed);
    scratch.release();
    expect(scratch.markerCapacity).toBe(0);
    expect(scratch.resultCapacity).toBe(0);
    expect(scratch.count).toBe(0);
    expect(index.query(bounds(0), scratch)).toBe(1);
    expect(scratch.at(0)).toBe(0);
    expect(allocations).toBe(warmed.allocations + 1);
    expect(copy.mock.calls.length).toBe(0);
  } finally {
    scratch.release();
    copy.mockRestore();
    vi.unstubAllGlobals();
  }
});

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
  const originalLog2 = Math.log2;
  const estimate = vi.spyOn(Math, "log2").mockImplementation((value) => {
    sliceWork += 1;
    return originalLog2(value);
  });
  const liveSize = index.size;
  return {
    attach,
    estimate,
    get,
    heapify,
    push,
    values,
    counts: () => ({
      attaches: attach.mock.calls.length,
      comparisons,
      enumerations,
      estimates: estimate.mock.calls.length,
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
      for (const spy of [get, values, attach, heapify, push, estimate]) spy.mockRestore();
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
  const synchronousEstimate = vi.spyOn(Math, "log2");
  try {
    index.insertMany(insertions);
    expect(synchronousEstimate).not.toHaveBeenCalled();
  } finally {
    synchronousEstimate.mockRestore();
  }
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
    expect(observedClear.estimate).not.toHaveBeenCalled();
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
    // For one-cell entries in an empty heap, the unchanged estimate exceeds 1,024 at entry 142.
    expect(observedRestore.estimate.mock.calls.length).toBeGreaterThan(0);
    expect(observedRestore.estimate.mock.calls.length).toBeLessThanOrEqual(142);
    expect(observedRestore.values).not.toHaveBeenCalled();
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

it("replaces every indexed entry without enumerating removed entries or repeating settled estimates", async () => {
  const index = new UniformSpatialIndex<number>();
  index.insertMany(insertions);
  const replacements = insertions.map(({ id, bounds: original }) => ({
    id,
    bounds: { ...original, minY: original.minY + 128, maxY: original.maxY + 128 },
  }));
  const observed = observeMutationWork(index);
  const cursor = index.beginQuery(bounds(0));
  const scratch = new SpatialQueryScratch<number>();
  try {
    const replaced = await index.prepareMutationTimeSliced(
      insertions.map(({ id }) => id),
      replacements,
      observed.scheduler,
    );
    if (replaced === "cancelled") throw new Error("Expected a prepared full replacement.");
    expect(observed.get).toHaveBeenCalledTimes(ELEMENT_COUNT);
    expect(observed.counts().enumerations).toBe(0);
    expect(observed.values).not.toHaveBeenCalled();
    expect(observed.estimate).not.toHaveBeenCalled();
    expect(observed.attach).toHaveBeenCalledTimes(ELEMENT_COUNT);
    expect(observed.heapify).toHaveBeenCalledTimes(ELEMENT_COUNT / 2);
    expect(observed.counts().comparisons).toBeLessThanOrEqual(2 * ELEMENT_COUNT);
    expect(observed.counts().sliceWork).toBeLessThanOrEqual(MAX_SLICE_WORK);
    expect(observed.push).not.toHaveBeenCalled();
    expect(index.query(bounds(0), scratch)).toBe(1);
    const workBeforeCommit = observed.counts();
    replaced.commit();
    expect(observed.counts()).toEqual(workBeforeCommit);
    expect(() => replaced.commit()).toThrow("stale");
    expect(index.size).toBe(ELEMENT_COUNT);
    expect(index.membershipCount).toBe(ELEMENT_COUNT);
    expect(index.extentHeapEntryCount).toBe(ELEMENT_COUNT);
    expect(index.query(bounds(0), scratch)).toBe(0);
    expect(index.query(replacements[0]!.bounds, scratch)).toBe(1);
    expect(index.getMaximumBottom()).toBe(replacements[ELEMENT_COUNT - 1]!.bounds.maxY);
    expect(cursor.advance(1).stale).toBe(true);
  } finally {
    observed.restore();
  }
});
