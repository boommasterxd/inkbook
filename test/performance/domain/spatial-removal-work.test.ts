import { expect, it, vi } from "vitest";

import { SpatialQueryScratch, UniformSpatialIndex } from "../../../src/domain/spatial";
import type { IndexedEntry } from "../../../src/domain/spatial/index-state";
import * as bottomHeap from "../../../src/domain/spatial/max-bottom-heap";
import { SpatialMap } from "../../../src/domain/spatial/spatial-map";
import * as spatialMaps from "../../../src/domain/spatial/spatial-map";
import { SpatialSet } from "../../../src/domain/spatial/spatial-set";
import * as spatialNode from "../../../src/domain/spatial/spatial-node";
import { SpatialSlots } from "../../../src/domain/spatial/slot-storage";
import {
  MAX_OVERFLOW_ELEMENTS,
  MAX_SPATIAL_MEMBERSHIPS,
} from "../../../src/domain/spatial/capacity";
import {
  createSpatialSlots,
  observeSlotPageCopies,
  observeSlotPageReads,
} from "../../fixtures/domain/spatial-slots";

const REMOVED_COUNT = 1_025;
const MAX_HEIGHT = 2 * Math.ceil(Math.log2(10_000));
// Entry, slot, cell, column and bucket paths each retain AVL-bounded lookup/update work.
const MAX_ENTRY_COMPARISONS = 24 * MAX_HEIGHT;
const SLICE_COMPARISONS = 512;
const ready = { shouldYield: () => false, yieldControl: async () => undefined };
const bounds = (id: number) => ({ minX: id * 256 + 1, maxX: id * 256 + 2, minY: 1, maxY: 2 });

it("forks populated sets and slots without constructing discarded empty backing maps", () => {
  const set = new SpatialSet<number>();
  const slots = new SpatialSlots<number>();
  for (let index = 0; index < 10_000; index += 1) {
    set.add(index);
    slots.set(index, index);
  }
  // Observe imported backing-store construction. The Map's own retained fork is separate.
  const construct = vi.spyOn(spatialMaps, "SpatialMap");
  try {
    const emptySet = new SpatialSet<number>();
    const emptySlots = new SpatialSlots<number>();
    expect(emptySet.size).toBe(0);
    expect(emptySlots.length).toBe(0);
    expect(construct).toHaveBeenCalledTimes(1);
    construct.mockClear();
    const setFork = set.fork();
    const slotFork = slots.fork();
    const secondSetFork = setFork.fork();
    const secondSlotFork = slotFork.fork();
    expect(construct).not.toHaveBeenCalled();
    secondSetFork.delete(0);
    secondSlotFork.set(0, -1);
    setFork.delete(9_999);
    slotFork.set(9_999, -2);
    expect(set.size).toBe(10_000);
    expect(slots.get(0)).toBe(0);
    expect(slots.get(9_999)).toBe(9_999);
    expect(secondSetFork.size).toBe(9_999);
    expect(secondSlotFork.get(0)).toBe(-1);
    expect(secondSlotFork.get(9_999)).toBe(9_999);
    expect(slotFork.length).toBe(10_000);
  } finally {
    construct.mockRestore();
  }
});

it.each(["keys", "values", "entries", "iterator"] as const)(
  "uses one generator instance and one advance per %s entry in a 10K map",
  (kind) => {
    const map = new SpatialMap<number, number>();
    for (let key = 0; key < 10_000; key += 1) map.set(key, key);
    const iterator = kind === "iterator" ? map[Symbol.iterator]() : map[kind]();
    const generator = Object.getPrototypeOf(Object.getPrototypeOf(iterator)) as {
      next: (this: Generator<unknown>, ...args: [] | [unknown]) => IteratorResult<unknown>;
    };
    const original = generator.next;
    let advances = 0;
    let instances = 0;
    const observed = new WeakSet<Generator<unknown>>();
    const next = vi.spyOn(generator, "next").mockImplementation(function (
      this: Generator<unknown>,
      ...args
    ) {
      advances += 1;
      if (!observed.has(this)) {
        observed.add(this);
        instances += 1;
      }
      next.mockClear();
      return original.apply(this, args);
    });
    let values: unknown[];
    try {
      values = Array.from(iterator as Iterable<unknown>);
    } finally {
      next.mockRestore();
    }
    // One actual generator.next() per yielded entry, plus terminal completion.
    expect(instances).toBe(1);
    expect(advances).toBe(10_001);
    expect(values).toHaveLength(10_000);
    expect(values[0]).toEqual(kind === "keys" || kind === "values" ? 0 : [0, 0]);
    expect(values[9_999]).toEqual(kind === "keys" || kind === "values" ? 9_999 : [9_999, 9_999]);
  },
);

function observeRemoval(
  index: UniformSpatialIndex<number>,
  maximumEntryWork = MAX_ENTRY_COMPARISONS,
) {
  const map = new SpatialMap<number, number>() as unknown as {
    order: { compare: (first: unknown, second: unknown) => number };
  };
  const keyOrder = Object.getPrototypeOf(map.order) as typeof map.order;
  const originalCompare = keyOrder.compare;
  let comparisons = 0;
  let sliceComparisons = 0;
  let yields = 0;
  const compare = vi.spyOn(keyOrder, "compare").mockImplementation(function (
    this: typeof map.order,
    ...args
  ) {
    comparisons += 1;
    sliceComparisons += 1;
    return originalCompare.apply(this, args);
  });
  const entries = (index as unknown as { entries: SpatialMap<number, IndexedEntry<number>> })
    .entries;
  const enumerate = vi.spyOn(entries, "values");
  const membership = vi.spyOn(SpatialSet.prototype, "delete");
  const heapify = vi.spyOn(bottomHeap, "heapifyBottomAt");
  const push = vi.spyOn(bottomHeap, "pushBottom");
  const reads = vi.spyOn(SpatialMap.prototype, "get");
  const updateReads = vi.spyOn(SpatialMap.prototype, "getForUpdate");
  return {
    counts: () => ({
      comparisons,
      sliceComparisons,
      yields,
      memberships: membership.mock.calls.length,
      reads: reads.mock.calls.length + updateReads.mock.calls.length,
    }),
    scheduler: {
      shouldYield: () => sliceComparisons >= SLICE_COMPARISONS,
      yieldControl: async () => {
        expect(sliceComparisons).toBeLessThanOrEqual(SLICE_COMPARISONS + maximumEntryWork);
        sliceComparisons = 0;
        yields += 1;
      },
    },
    assertNoRebuild: (expectedPushes = 0) => {
      expect(enumerate).not.toHaveBeenCalled();
      expect(heapify).not.toHaveBeenCalled();
      expect(push).toHaveBeenCalledTimes(expectedPushes);
    },
    restore: () =>
      [compare, enumerate, membership, heapify, push, reads, updateReads].forEach((spy) =>
        spy.mockRestore(),
      ),
  };
}

function observeNodeAllocations() {
  const originalCreate = spatialNode.createSpatialNode;
  const originalCopy = spatialNode.copySpatialNode;
  let created = 0;
  let copied = 0;
  const create = vi.spyOn(spatialNode, "createSpatialNode").mockImplementation((...args) => {
    created += 1;
    create.mockClear();
    return originalCreate(...args);
  });
  const copy = vi.spyOn(spatialNode, "copySpatialNode").mockImplementation((...args) => {
    copied += 1;
    copy.mockClear();
    return originalCopy(...args);
  });
  return {
    counts: () => ({ created, copied }),
    restore: () => {
      create.mockRestore();
      copy.mockRestore();
    },
  };
}

it("copies first-touched fork paths once and mutates subsequent private writes without allocation", () => {
  const map = new SpatialMap<number, number>();
  for (let key = 0; key < 10_000; key += 1) map.set(key, key);
  const allocated = observeNodeAllocations();
  try {
    const fork = map.fork();
    expect(allocated.counts()).toEqual({ created: 0, copied: 0 });
    fork.set(0, -1);
    const copied = allocated.counts().copied;
    expect(copied).toBeGreaterThan(0);
    expect(copied).toBeLessThanOrEqual(2 * MAX_HEIGHT);
    fork.set(0, -2);
    expect(allocated.counts()).toEqual({ created: 0, copied });
    expect(map.get(0)).toBe(0);
    map.set(9_999, -3);
    expect(allocated.counts().copied).toBeLessThanOrEqual(4 * MAX_HEIGHT);
    expect(fork.get(9_999)).toBe(9_999);
    const second = fork.fork();
    second.set(0, -4);
    fork.set(0, -5);
    expect(map.get(0)).toBe(0);
    expect(fork.get(0)).toBe(-5);
    expect(second.get(0)).toBe(-4);
    expect(allocated.counts().created).toBe(0);
  } finally {
    allocated.restore();
  }
});

it.each([2_000, 10_000])(
  "bounds partial dense removal by touched paths with %i indexed entries",
  async (count) => {
    const index = new UniformSpatialIndex<number>();
    // All entries share one bucket: removal must not enumerate that bucket's retained members.
    index.insertMany(Array.from({ length: count }, (_, id) => ({ id, bounds: bounds(0) })));
    const observed = observeRemoval(index);
    const cursor = index.beginQuery(bounds(0));
    const removals = Array.from({ length: REMOVED_COUNT }, (_, id) => id);
    try {
      const plan = await index.prepareMutationTimeSliced(removals, [], observed.scheduler);
      if (plan === "cancelled") throw new Error("Expected local removal.");
      expect(observed.counts().memberships).toBe(REMOVED_COUNT);
      expect(observed.counts().reads).toBeLessThanOrEqual(REMOVED_COUNT * 3);
      expect(observed.counts().comparisons).toBeLessThanOrEqual(
        REMOVED_COUNT * MAX_ENTRY_COMPARISONS,
      );
      expect(observed.counts().sliceComparisons).toBeLessThanOrEqual(
        SLICE_COMPARISONS + MAX_ENTRY_COMPARISONS,
      );
      expect(observed.counts().yields).toBeGreaterThan(0);
      observed.assertNoRebuild();
      expect(index.size).toBe(count);
      const beforeCommit = observed.counts();
      plan.commit();
      expect(observed.counts()).toEqual(beforeCommit);
      observed.assertNoRebuild();
      expect(index.size).toBe(count - REMOVED_COUNT);
      expect(index.membershipCount).toBe(count - REMOVED_COUNT);
      expect(index.cellCount).toBe(1);
      expect(cursor.advance(1).stale).toBe(true);
      expect(cursor.memoryUsage()).toBe(0);
      expect(() => plan.commit()).toThrow("stale");
    } finally {
      observed.restore();
      cursor.cancel();
    }
    const scratch = new SpatialQueryScratch<number>();
    expect(index.query(bounds(0), scratch)).toBe(count - REMOVED_COUNT);
    expect(scratch.at(0)).toBe(REMOVED_COUNT);
    expect(index.getMaximumBottom()).toBe(2);
    index.insertMany(removals.map((id) => ({ id, bounds: bounds(1) })));
    expect(index.size).toBe(count);
    expect(index.query(bounds(1), scratch)).toBe(REMOVED_COUNT);
    expect((index as unknown as { slots: { length: number } }).slots.length).toBe(count);
    scratch.release();
  },
);

it.each(["cancelled", "stale", "final"])(
  "discards %s local preparation after actual membership work",
  async (mode) => {
    const index = new UniformSpatialIndex<number>();
    index.insertMany(Array.from({ length: 10_000 }, (_, id) => ({ id, bounds: bounds(id) })));
    const observed = observeRemoval(index);
    let cancelled = false;
    try {
      const result = await index.prepareMutationTimeSliced(
        Array.from({ length: REMOVED_COUNT }, (_, id) => id),
        [],
        {
          isCancelled: () => cancelled,
          shouldYield: () =>
            observed.counts().memberships >= (mode === "final" ? REMOVED_COUNT : 2),
          yieldControl: async () => {
            if (mode === "stale") index.insert(-1, bounds(-1));
            else cancelled = true;
          },
        },
      );
      expect(result).toBe("cancelled");
      expect(observed.counts().memberships).toBe(mode === "final" ? REMOVED_COUNT : 2);
      observed.assertNoRebuild(mode === "stale" ? 1 : 0);
      expect(index.size).toBe(mode === "stale" ? 10_001 : 10_000);
    } finally {
      observed.restore();
    }
    const scratch = new SpatialQueryScratch<number>();
    expect(index.query(bounds(0), scratch)).toBe(1);
    expect(scratch.at(0)).toBe(0);
    const current = await index.prepareMutationTimeSliced(
      Array.from({ length: REMOVED_COUNT }, (_, id) => id),
      [],
      ready,
    );
    if (current === "cancelled") throw new Error("Expected current removal.");
    current.commit();
    expect(index.query(bounds(0), scratch)).toBe(0);
    scratch.release();
  },
);

it("prepares maximum-cell removals without publishing retained state at full membership capacity", async () => {
  const index = new UniformSpatialIndex<number>();
  const maximum = { minX: 0, minY: 0, maxX: 15 * 256, maxY: 15 * 256 };
  const remainder = { minX: 0, minY: 0, maxX: 4 * 256, maxY: 40 * 256 };
  const allocated = observeNodeAllocations();
  const prototype = SpatialMap.prototype as {
    set: (key: unknown, value: unknown) => SpatialMap<unknown, unknown>;
  };
  const originalSet = prototype.set;
  let setCalls = 0;
  const sets = vi.spyOn(prototype, "set").mockImplementation(function (
    this: SpatialMap<unknown, unknown>,
    ...args
  ) {
    setCalls += 1;
    sets.mockClear();
    return originalSet.apply(this, args);
  });
  try {
    index.insertMany(
      Array.from({ length: 10_000 }, (_, id) => ({
        id,
        bounds: id < 988 ? maximum : id === 988 ? remainder : bounds(0),
      })),
    );
    const columns = (index as unknown as { cells: { size: number } }).cells.size;
    // Key and insertion-order trees each allocate one node per entry, column,
    // occupied cell and membership. No initial-build path is shared or needs copying.
    expect(allocated.counts()).toEqual({
      created: 2 * (index.size + columns + index.cellCount + index.membershipCount),
      copied: 0,
    });
    // Each logical key is installed once. Mutating a private bucket needs no outer Set.
    expect(setCalls).toBe(index.size + columns + index.cellCount + index.membershipCount);
  } finally {
    allocated.restore();
    sets.mockRestore();
  }
  expect(index.membershipCount).toBe(262_144);
  const observed = observeRemoval(index, 256 * MAX_ENTRY_COMPARISONS);
  try {
    // One entry owns at most 256 memberships; this is an indivisible structural edit.
    const prepared = await index.prepareMutationTimeSliced([0, 1, 2, 3, 4], [], observed.scheduler);
    if (prepared === "cancelled") throw new Error("Expected capacity removal.");
    expect(observed.counts().memberships).toBe(5 * 256);
    expect(observed.counts().reads).toBe(5 + 2 * 5 * 256);
    expect(observed.counts().comparisons).toBeLessThanOrEqual(5 * 256 * MAX_ENTRY_COMPARISONS);
    observed.assertNoRebuild();
    const beforeCommit = observed.counts();
    prepared.commit();
    expect(observed.counts()).toEqual(beforeCommit);
    expect(index.membershipCount).toBe(262_144 - 5 * 256);
  } finally {
    observed.restore();
  }
});

it.each([10_000, MAX_SPATIAL_MEMBERSHIPS + MAX_OVERFLOW_ELEMENTS])(
  "bounds actual page allocation and lookup work for %s spatial slots",
  (count) => {
    const arrays = observeSlotPageCopies();
    const set = vi.spyOn(SpatialMap.prototype, "set");
    let slots: SpatialSlots<number>;
    try {
      arrays.reset();
      slots = createSpatialSlots(count);
      let expectedPages = 0;
      for (let capacity = 32; ; capacity *= 32) {
        expectedPages += Math.ceil(count / capacity);
        if (capacity >= count) break;
      }
      expect(arrays.created).toHaveLength(expectedPages);
      expect(arrays.created.every((length) => length === 32)).toBe(true);
      expect(arrays.copied).toEqual([]);
      expect(set).not.toHaveBeenCalled();
    } finally {
      arrays.restore();
      set.mockRestore();
    }
    const reads = observeSlotPageReads(slots);
    const get = vi.spyOn(SpatialMap.prototype, "get");
    try {
      let sum = 0;
      for (let slot = 0; slot < count; slot += 1) sum += slots.get(slot)!;
      expect(sum).toBe((count * (count - 1)) / 2);
      expect(reads.count()).toBe(count * Math.ceil(Math.log2(count) / 5));
      expect(get).not.toHaveBeenCalled();
    } finally {
      reads.restore();
      get.mockRestore();
    }
  },
);

it("copies only touched slot pages and releases deleted values before slot reuse", () => {
  const slots = createSpatialSlots(10_000);
  const pages = observeSlotPageCopies();
  try {
    pages.reset();
    const first = slots.fork();
    const second = first.fork();
    expect(pages.created).toEqual([]);
    expect(pages.copied).toEqual([]);
    second.set(0, -1);
    expect(pages.copied).toEqual([32, 32, 32]);
    pages.reset();
    second.set(1, -2);
    expect(pages.created).toEqual([]);
    expect(pages.copied).toEqual([]);
    slots.set(9_999, -3);
    expect(pages.copied).toEqual([32, 32, 32]);
    expect(first.get(0)).toBe(0);
    expect(first.get(9_999)).toBe(9_999);
    expect(second.get(9_999)).toBe(9_999);
    pages.reset();
    for (let slot = 0; slot < 10_000; slot += 1) second.set(slot, undefined);
    expect(pages.created).toEqual([]);
    expect(pages.copied.length).toBeLessThanOrEqual(324);
    expect(pages.copied.every((length) => length === 32)).toBe(true);
    expect((second as unknown as { root: unknown }).root).toBeUndefined();
    expect(second.length).toBe(10_000);
    second.set(0, 42);
    expect(pages.created).toEqual([32]);
    expect(second.get(0)).toBe(42);
    expect(first.get(0)).toBe(0);
  } finally {
    pages.restore();
  }
});

it("adopts removal roots without iterating existing extent batches during a live rebuild", async () => {
  const index = new UniformSpatialIndex<number>();
  index.insertMany(Array.from({ length: 10_000 }, (_, id) => ({ id, bounds: bounds(id) })));
  index.extentRebuildRecommended = true;
  expect(index.beginExtentRebuild()).toBe(true);
  for (let batch = 0; batch < 4; batch += 1) {
    index.commitPreparedReplacements(
      index.prepareReplacements(
        Array.from({ length: 65 }, (_, id) => ({
          id: 9_000 + id,
          bounds: bounds(id + 20_000 + batch),
        })),
      ),
    );
  }
  const batches = (index as unknown as { extentBatchHeaps: unknown[][] }).extentBatchHeaps;
  expect(batches.length).toBe(4);
  const iterate = vi.spyOn(batches, Symbol.iterator);
  const observed = observeRemoval(index);
  try {
    const plan = await index.prepareMutationTimeSliced(
      Array.from({ length: REMOVED_COUNT }, (_, id) => id),
      [],
      observed.scheduler,
    );
    if (plan === "cancelled") throw new Error("Expected removal during rebuild.");
    expect(index.extentHeapEntryCount).toBe(10_260);
    expect(iterate).not.toHaveBeenCalled();
    const beforeCommit = observed.counts();
    plan.commit();
    expect(observed.counts()).toEqual(beforeCommit);
    expect(iterate).not.toHaveBeenCalled();
  } finally {
    observed.restore();
    iterate.mockRestore();
  }
  // Forty 256-entry slices cover the complete 10K slot limit and final adoption.
  for (let step = 0; step < 40; step += 1) {
    if (index.rebuildExtentStep()) break;
  }
  const state = index as unknown as { extentBatchHeaps: unknown[][] };
  expect(index.extentHeapEntryCount).toBe(
    (index as unknown as { extentHeap: unknown[] }).extentHeap.length +
      state.extentBatchHeaps.reduce((count, heap) => count + heap.length, 0),
  );
  expect(index.getMaximumBottom()).toBe(2);
});
