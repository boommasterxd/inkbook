import { expect, it, vi } from "vitest";

import { UniformSpatialIndex } from "../../../src/domain/spatial";
import { MAX_OVERFLOW_ELEMENTS } from "../../../src/domain/spatial/capacity";
import { SpatialSlots } from "../../../src/domain/spatial/slot-storage";

const REMOVED_OVERFLOW = MAX_OVERFLOW_ELEMENTS / 2;
const MAX_SLICE_READS = 8;
const gridBounds = { minX: 0, maxX: 1, minY: 0, maxY: 2 };
const overflowBounds = { minX: 0, maxX: 65_536, minY: 0, maxY: 1_000 };
const insertions = Array.from({ length: 10_000 }, (_, id) => ({
  id,
  bounds:
    id >= MAX_OVERFLOW_ELEMENTS
      ? gridBounds
      : { ...overflowBounds, maxY: id < REMOVED_OVERFLOW ? 1_000 : 500 },
}));
const removals = Array.from({ length: REMOVED_OVERFLOW }, (_, id) => id);
const lowerRemovals = removals.map((id) => id + REMOVED_OVERFLOW);
const ready = { shouldYield: () => false, yieldControl: async () => undefined };

function observeOverflowReads() {
  const prototype = SpatialSlots.prototype as {
    get: (this: SpatialSlots<unknown>, slot: number) => unknown;
  };
  const original = prototype.get;
  let reads = 0;
  let sliceReads = 0;
  const get = vi.spyOn(prototype, "get").mockImplementation(function (
    this: SpatialSlots<unknown>,
    slot,
  ) {
    reads += 1;
    sliceReads += 1;
    return original.call(this, slot);
  });
  return {
    count: () => reads,
    sliceCount: () => sliceReads,
    finishSlice: () => {
      expect(sliceReads).toBeLessThanOrEqual(MAX_SLICE_READS);
      sliceReads = 0;
    },
    restore: () => get.mockRestore(),
  };
}

it("retains the overflow maximum without reading slots when deleting only lower overflow entries", async () => {
  const index = new UniformSpatialIndex<number>();
  index.insertMany(insertions);
  const observed = observeOverflowReads();
  try {
    const plan = await index.prepareMutationTimeSliced(lowerRemovals, [], ready);
    if (plan === "cancelled") throw new Error("Expected lower overflow removal.");
    expect(observed.count()).toBe(0);
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
    plan.commit();
    expect(observed.count()).toBe(0);
    expect(index.size).toBe(10_000 - REMOVED_OVERFLOW);
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS - REMOVED_OVERFLOW);
    expect(index.getMaximumBottom()).toBe(1_000);
  } finally {
    observed.restore();
  }
});

it("repairs the exact overflow maximum in one cooperative scan before atomic 10K publication", async () => {
  const index = new UniformSpatialIndex<number>();
  index.insertMany(insertions);
  expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
  const observed = observeOverflowReads();
  let yields = 0;
  try {
    const plan = await index.prepareMutationTimeSliced(removals, [], {
      shouldYield: () => observed.sliceCount() >= MAX_SLICE_READS,
      yieldControl: async () => {
        observed.finishSlice();
        yields += 1;
        expect(index.size).toBe(10_000);
        expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
        expect(index.getMaximumBottom()).toBe(1_000);
      },
    });
    if (plan === "cancelled") throw new Error("Expected prepared overflow removal.");
    observed.finishSlice();
    // Only the retained overflow entries are read once, regardless of removed equal maxima.
    expect(observed.count()).toBe(MAX_OVERFLOW_ELEMENTS - REMOVED_OVERFLOW);
    expect(yields).toBeGreaterThan(0);
    const beforeCommit = observed.count();
    plan.commit();
    expect(observed.count()).toBe(beforeCommit);
    expect(index.size).toBe(10_000 - REMOVED_OVERFLOW);
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS - REMOVED_OVERFLOW);
    expect(index.getMaximumBottom()).toBe(500);
    expect(() => plan.commit()).toThrow("stale");
  } finally {
    observed.restore();
  }
  index.insertMany(removals.map((id) => ({ id, bounds: overflowBounds })));
  expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
  expect((index as unknown as { slots: { length: number } }).slots.length).toBe(10_000);
  expect(index.getMaximumBottom()).toBe(1_000);
  const all = await index.prepareMutationTimeSliced(
    Array.from({ length: MAX_OVERFLOW_ELEMENTS }, (_, id) => id),
    [],
    ready,
  );
  if (all === "cancelled") throw new Error("Expected complete overflow removal.");
  all.commit();
  expect(index.overflowCount).toBe(0);
  expect(index.getMaximumBottom()).toBe(2);
});

it.each(["cancelled", "stale", "final"] as const)(
  "discards %s overflow repair after actual reads without publishing and permits reuse",
  async (mode) => {
    const index = new UniformSpatialIndex<number>();
    index.insertMany(insertions);
    const observed = observeOverflowReads();
    const expectedReads = mode === "final" ? MAX_OVERFLOW_ELEMENTS - REMOVED_OVERFLOW : 8;
    let cancelled = false;
    try {
      const plan = await index.prepareMutationTimeSliced(removals, [], {
        isCancelled: () => cancelled,
        shouldYield: () => observed.count() >= expectedReads,
        yieldControl: async () => {
          expect(index.size).toBe(10_000);
          expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
          expect(index.getMaximumBottom()).toBe(1_000);
          if (mode === "stale") index.insert(-1, gridBounds);
          else cancelled = true;
        },
      });
      expect(plan).toBe("cancelled");
      expect(observed.count()).toBe(expectedReads);
      expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
      expect(index.size).toBe(mode === "stale" ? 10_001 : 10_000);
      expect(index.getMaximumBottom()).toBe(1_000);
    } finally {
      observed.restore();
    }
    const current = await index.prepareMutationTimeSliced(removals, [], ready);
    if (current === "cancelled") throw new Error("Expected reusable overflow removal.");
    current.commit();
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS - REMOVED_OVERFLOW);
    expect(index.getMaximumBottom()).toBe(500);
  },
);
