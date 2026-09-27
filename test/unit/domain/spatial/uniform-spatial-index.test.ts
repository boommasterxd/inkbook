import { describe, expect, it, vi } from "vitest";
import * as bottomHeap from "../../../../src/domain/spatial/max-bottom-heap";

import {
  MAX_OVERFLOW_ELEMENTS,
  MAX_SPATIAL_MEMBERSHIPS,
  SpatialQueryScratch,
  UniformSpatialIndex,
  type SpatialBounds,
} from "../../../../src/domain/spatial";

function idsFrom<Id>(scratch: SpatialQueryScratch<Id>): Id[] {
  const ids: Id[] = [];
  for (let index = 0; index < scratch.count; index += 1) ids.push(scratch.at(index));
  return ids;
}

const MAXIMUM_GRID_BOUNDS = { maxX: 65_535, maxY: 255, minX: 0, minY: 0 } as const;
const LARGE_GRID_ENTRY_COUNT = MAX_SPATIAL_MEMBERSHIPS / 256 - 1;

function createNearMembershipCapacityIndex(tailBounds: SpatialBounds): UniformSpatialIndex<number> {
  const index = new UniformSpatialIndex<number>();
  for (let id = 0; id < LARGE_GRID_ENTRY_COUNT; id += 1) {
    index.insert(id, MAXIMUM_GRID_BOUNDS);
  }
  index.insert(LARGE_GRID_ENTRY_COUNT, tailBounds);
  return index;
}

describe("UniformSpatialIndex queries", () => {
  it("queries intersecting cells, rejects candidates by exact bounds, and deduplicates IDs", () => {
    const index = new UniformSpatialIndex<string>();
    const scratch = new SpatialQueryScratch<string>();
    index.insert("wide", { maxX: 300, maxY: 20, minX: 200, minY: 10 });
    index.insert("cell-candidate", { maxX: 250, maxY: 220, minX: 240, minY: 210 });

    expect(index.query({ maxX: 290, maxY: 30, minX: 210, minY: 0 }, scratch)).toBe(1);
    expect(idsFrom(scratch)).toEqual(["wide"]);
    expect(scratch.candidateVisitCount).toBe(3);
    expect(scratch.duplicateVisitCount).toBe(1);
  });

  it("keeps 256-cell elements in the grid and routes larger elements to overflow", () => {
    const index = new UniformSpatialIndex<string>();
    const scratch = new SpatialQueryScratch<string>();
    index.insert("grid", { maxX: 65_535, maxY: 255, minX: 0, minY: 0 });
    index.insert("overflow", { maxX: 65_536, maxY: 255, minX: 0, minY: 0 });

    expect(index.overflowCount).toBe(1);
    expect(index.cellCount).toBe(256);
    expect(index.query({ maxX: 65_536, maxY: 255, minX: 65_535, minY: 0 }, scratch)).toBe(2);
    expect(new Set(idsFrom(scratch))).toEqual(new Set(["grid", "overflow"]));
  });

  it("checks overflow bounds exactly instead of returning every oversized element", () => {
    const index = new UniformSpatialIndex<string>();
    const scratch = new SpatialQueryScratch<string>();
    index.insert("million-unit-stroke", {
      maxX: 1_000_000,
      maxY: 1_000_000,
      minX: 999_000,
      minY: -1_000_000,
    });

    expect(index.query({ maxX: 10, maxY: 10, minX: 0, minY: 0 }, scratch)).toBe(0);
    expect(index.query({ maxX: 999_500, maxY: 50, minX: 999_400, minY: -50 }, scratch)).toBe(1);
    expect(scratch.at(0)).toBe("million-unit-stroke");
  });
});

describe("UniformSpatialIndex mutations", () => {
  it("replaces grid and overflow membership incrementally and removes retained cell keys", () => {
    const index = new UniformSpatialIndex<string>();
    const scratch = new SpatialQueryScratch<string>();
    const first = { maxX: 20, maxY: 20, minX: 10, minY: 10 };
    const oversized = { maxX: 1_000_000, maxY: 1_000_000, minX: 0, minY: 0 };
    index.insert("element", first);

    index.replace("element", oversized);
    expect(index.cellCount).toBe(0);
    expect(index.overflowCount).toBe(1);
    expect(index.query(first, scratch)).toBe(1);

    const moved = { maxX: 620, maxY: 620, minX: 600, minY: 600 };
    index.replace("element", moved);
    expect(index.overflowCount).toBe(0);
    expect(index.query(first, scratch)).toBe(0);
    expect(index.query(moved, scratch)).toBe(1);

    expect(index.remove("element")).toBe(true);
    expect(index.remove("element")).toBe(false);
    expect(index.size).toBe(0);
    expect(index.cellCount).toBe(0);
  });

  it("rejects invalid replacements without mutating the current entry", () => {
    const index = new UniformSpatialIndex<string>();
    const scratch = new SpatialQueryScratch<string>();
    const original = { maxX: 10, maxY: 10, minX: 0, minY: 0 };
    index.insert("stable", original);

    expect(() => index.replace("stable", { maxX: Number.NaN, maxY: 20, minX: 0, minY: 0 })).toThrow(
      TypeError,
    );
    expect(() => index.replace("stable", { maxX: -1, maxY: 20, minX: 0, minY: 0 })).toThrow(
      RangeError,
    );
    expect(index.query(original, scratch)).toBe(1);
    expect(scratch.at(0)).toBe("stable");
  });

  it("enforces the overflow cap without partially inserting or replacing", () => {
    const index = new UniformSpatialIndex<number>();
    const oversized = { maxX: 1_000_000, maxY: 1_000_000, minX: 0, minY: 0 };
    for (let id = 0; id < MAX_OVERFLOW_ELEMENTS; id += 1) index.insert(id, oversized);
    index.insert(MAX_OVERFLOW_ELEMENTS, { maxX: 10, maxY: 10, minX: 0, minY: 0 });

    expect(() => index.insert(MAX_OVERFLOW_ELEMENTS + 1, oversized)).toThrow(RangeError);
    expect(() => index.replace(MAX_OVERFLOW_ELEMENTS, oversized)).toThrow(RangeError);
    expect(index.size).toBe(MAX_OVERFLOW_ELEMENTS + 1);
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);

    expect(index.remove(0)).toBe(true);
    index.replace(MAX_OVERFLOW_ELEMENTS, oversized);
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS);
  });
});

describe("UniformSpatialIndex resource bounds and prepared batches", () => {
  it("enforces aggregate grid membership before allocating cells or changing entries", () => {
    const index = createNearMembershipCapacityIndex({ maxX: 1, maxY: 1, minX: 0, minY: 0 });
    index.insert(LARGE_GRID_ENTRY_COUNT + 1, {
      maxX: 257,
      maxY: 1,
      minX: 257,
      minY: 0,
    });

    const size = index.size;
    const memberships = index.membershipCount;
    expect(() => index.insert(size, MAXIMUM_GRID_BOUNDS)).toThrow(RangeError);
    expect(() => index.replace(LARGE_GRID_ENTRY_COUNT, MAXIMUM_GRID_BOUNDS)).toThrow(RangeError);
    const oneHundredTwentyNineCells = { maxX: 33_023, maxY: 255, minX: 0, minY: 0 };
    expect(() =>
      index.prepareReplacements([
        { bounds: oneHundredTwentyNineCells, id: LARGE_GRID_ENTRY_COUNT },
        { bounds: oneHundredTwentyNineCells, id: LARGE_GRID_ENTRY_COUNT + 1 },
      ]),
    ).toThrow(RangeError);
    expect(index.size).toBe(size);
    expect(index.membershipCount).toBe(memberships);
  });

  it("preflights cumulative batch insertions at the exact membership cap", () => {
    const index = createNearMembershipCapacityIndex({
      maxX: 65_279,
      maxY: 255,
      minX: 0,
      minY: 0,
    });
    const size = index.size;

    expect(index.membershipCount).toBe(MAX_SPATIAL_MEMBERSHIPS - 1);
    expect(() =>
      index.insertMany([
        { bounds: { maxX: 1, maxY: 1, minX: 0, minY: 0 }, id: size },
        { bounds: { maxX: 257, maxY: 1, minX: 257, minY: 0 }, id: size + 1 },
      ]),
    ).toThrow(RangeError);
    expect(index.size).toBe(size);
    expect(index.membershipCount).toBe(MAX_SPATIAL_MEMBERSHIPS - 1);
  });
});

it("heapifies a large batch in bounded preparation slices before atomic publication", async () => {
  const index = new UniformSpatialIndex<number>();
  const original = { maxX: 20, maxY: 20, minX: 10, minY: 10 };
  const replacements = Array.from({ length: 1_024 }, (_, id) => ({
    bounds: { maxX: 40, maxY: id + 40, minX: 30, minY: id + 30 },
    id,
  }));
  index.insertMany(replacements.map(({ id }) => ({ bounds: original, id })));
  const sift = vi.spyOn(bottomHeap, "heapifyBottomAt");
  const visitsAtYield: number[] = [];
  try {
    const plan = await index.prepareReplacementsTimeSliced(replacements, {
      shouldYield: () => false,
      yieldControl: async () => {
        visitsAtYield.push(sift.mock.calls.length);
        expect(index.getMaximumBottom()).toBe(20);
      },
    });
    expect(plan).not.toBe("cancelled");
    if (plan === "cancelled") return;
    expect(visitsAtYield).toEqual([256, 512]);
    expect(sift).toHaveBeenCalledTimes(512);
    expect(index.getMaximumBottom()).toBe(20);
    index.commitPreparedReplacements(plan);
    expect(index.getMaximumBottom()).toBe(1_063);
  } finally {
    sift.mockRestore();
  }
});

describe("UniformSpatialIndex prepared replacement batches", () => {
  it("prepares and atomically commits bounded replacement batches", () => {
    const index = new UniformSpatialIndex<string>();
    const scratch = new SpatialQueryScratch<string>();
    const original = { maxX: 20, maxY: 20, minX: 10, minY: 10 };
    const movedA = { maxX: 40, maxY: 40, minX: 30, minY: 30 };
    const movedB = { maxX: 60, maxY: 60, minX: 50, minY: 50 };
    index.insert("a", original);
    index.insert("b", original);

    const plan = index.prepareReplacements([
      { bounds: movedA, id: "a" },
      { bounds: movedB, id: "b" },
    ]);
    expect(plan.replacementCount).toBe(2);
    expect(index.query(original, scratch)).toBe(2);

    index.commitPreparedReplacements(plan);
    expect(index.query(original, scratch)).toBe(0);
    expect(index.query(movedA, scratch)).toBe(1);
    expect(scratch.at(0)).toBe("a");
    expect(index.query(movedB, scratch)).toBe(1);
    expect(scratch.at(0)).toBe("b");
    expect(index.getMaximumBottom()).toBe(60);
    expect(() => index.commitPreparedReplacements(plan)).toThrow(Error);
  });

  it("rejects invalid, duplicate, and stale replacement plans without partial mutation", () => {
    const index = new UniformSpatialIndex<string>();
    const original = { maxX: 20, maxY: 20, minX: 10, minY: 10 };
    const moved = { maxX: 520, maxY: 520, minX: 510, minY: 510 };
    index.insert("stable", original);

    expect(() =>
      index.prepareReplacements([
        { bounds: moved, id: "stable" },
        { bounds: moved, id: "stable" },
      ]),
    ).toThrow(RangeError);
    expect(() => index.prepareReplacements([{ bounds: moved, id: "missing" }])).toThrow(Error);
    expect(() =>
      index.prepareReplacements([{ bounds: { ...moved, maxX: Number.NaN }, id: "stable" }]),
    ).toThrow(TypeError);

    const stale = index.prepareReplacements([{ bounds: moved, id: "stable" }]);
    index.insert("other", original);
    expect(() => index.commitPreparedReplacements(stale)).toThrow(Error);
    const scratch = new SpatialQueryScratch<string>();
    expect(index.query(original, scratch)).toBe(2);
  });

  it("cancels sliced preparation without publishing staged index entries", async () => {
    const index = new UniformSpatialIndex<number>();
    const scratch = new SpatialQueryScratch<number>();
    const original = { maxX: 20, maxY: 20, minX: 10, minY: 10 };
    const replacements = Array.from({ length: 128 }, (_, id) => {
      index.insert(id, original);
      return { bounds: { maxX: 40, maxY: 40, minX: 30, minY: 30 }, id };
    });
    let yields = 0;

    const prepared = await index.prepareReplacementsTimeSliced(replacements, {
      isCancelled: () => yields === 5,
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
        expect(index.query(original, scratch)).toBe(128);
      },
    });

    expect(prepared).toBe("cancelled");
    expect(yields).toBe(5);
    expect(index.query(original, scratch)).toBe(128);
  });

  it("preflights cumulative overflow capacity for the complete batch", () => {
    const index = new UniformSpatialIndex<number>();
    const grid = { maxX: 20, maxY: 20, minX: 10, minY: 10 };
    const oversized = { maxX: 1_000_000, maxY: 1_000_000, minX: 0, minY: 0 };
    for (let id = 0; id < MAX_OVERFLOW_ELEMENTS - 1; id += 1) index.insert(id, oversized);
    index.insert(MAX_OVERFLOW_ELEMENTS, grid);
    index.insert(MAX_OVERFLOW_ELEMENTS + 1, grid);

    expect(() =>
      index.prepareReplacements([
        { bounds: oversized, id: MAX_OVERFLOW_ELEMENTS },
        { bounds: oversized, id: MAX_OVERFLOW_ELEMENTS + 1 },
      ]),
    ).toThrow(RangeError);
    expect(index.overflowCount).toBe(MAX_OVERFLOW_ELEMENTS - 1);
    expect(index.membershipCount).toBe(2);
  });
});

describe("UniformSpatialIndex edge cases", () => {
  it("supports sparse queries spanning far more empty cells than occupied cells", () => {
    const index = new UniformSpatialIndex<string>();
    const scratch = new SpatialQueryScratch<string>();
    index.insert("negative", { maxX: -900_000, maxY: -900_000, minX: -900_010, minY: -900_010 });
    index.insert("positive", { maxX: 900_010, maxY: 900_010, minX: 900_000, minY: 900_000 });

    expect(
      index.query(
        { maxX: 1_000_000, maxY: 1_000_000, minX: -1_000_000, minY: -1_000_000 },
        scratch,
      ),
    ).toBe(2);
    expect(new Set(idsFrom(scratch))).toEqual(new Set(["negative", "positive"]));
  });

  it("rejects duplicate inserts, missing replacements, and unsupported coordinates", () => {
    const index = new UniformSpatialIndex<string>();
    const bounds = { maxX: 1, maxY: 1, minX: 0, minY: 0 };
    index.insert("id", bounds);

    expect(() => index.insert("id", bounds)).toThrow(Error);
    expect(() => index.replace("missing", bounds)).toThrow(Error);
    expect(() =>
      index.query({ maxX: Number.MAX_VALUE, maxY: 1, minX: 0, minY: 0 }, new SpatialQueryScratch()),
    ).toThrow(RangeError);
  });

  it("accepts generic object IDs by identity", () => {
    const id = { localSlot: 7 };
    const other = { localSlot: 7 };
    const bounds: SpatialBounds = { maxX: 1, maxY: 1, minX: 0, minY: 0 };
    const index = new UniformSpatialIndex<typeof id>();
    const scratch = new SpatialQueryScratch<typeof id>();
    index.insert(id, bounds);

    expect(index.query(bounds, scratch)).toBe(1);
    expect(scratch.at(0)).toBe(id);
    expect(index.remove(other)).toBe(false);
  });
});
