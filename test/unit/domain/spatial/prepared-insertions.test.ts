import { describe, expect, it } from "vitest";

import {
  MAX_OVERFLOW_ELEMENTS,
  SpatialQueryScratch,
  UniformSpatialIndex,
} from "../../../../src/domain/spatial";
import { SpatialInsertionPreparation } from "../../../../src/domain/spatial/insertion-preparation";

const BOUNDS = { maxX: 20, maxY: 20, minX: 0, minY: 0 };

describe("prepared spatial insertions", () => {
  it("stages immutable bounds without changing queries, capacity, or extent", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("existing", BOUNDS);
    const bounds = { ...BOUNDS, maxY: 40 };
    const plan = index.prepareInsertions([{ bounds, id: "new" }]);
    bounds.maxY = 1_000;
    expect(index.size).toBe(1);
    expect(index.membershipCount).toBe(1);
    expect(index.getMaximumBottom()).toBe(20);
    index.commitPreparedInsertions(plan);
    const scratch = new SpatialQueryScratch<string>();
    expect(index.query({ ...BOUNDS, minY: 30, maxY: 50 }, scratch)).toBe(1);
    expect(scratch.at(0)).toBe("new");
    expect(index.getMaximumBottom()).toBe(40);
    expect(index.membershipCount).toBe(2);
    expect(() => index.commitPreparedInsertions(plan)).toThrow("stale");
  });

  it("rejects foreign and stale plans without partial insertion", () => {
    const index = new UniformSpatialIndex<string>();
    const other = new UniformSpatialIndex<string>();
    const plan = index.prepareInsertions([{ bounds: BOUNDS, id: "new" }]);
    expect(() => other.commitPreparedInsertions(plan)).toThrow("another index");
    index.insert("intervening", BOUNDS);
    expect(() => index.commitPreparedInsertions(plan)).toThrow("stale");
    expect(index.size).toBe(1);
    expect(other.size).toBe(0);
  });

  it("consumes an empty plan without invalidating another prepared insertion", () => {
    const index = new UniformSpatialIndex<string>();
    const empty = index.prepareInsertions([]);
    const plan = index.prepareInsertions([{ bounds: BOUNDS, id: "new" }]);
    index.commitPreparedInsertions(empty);
    expect(() => index.commitPreparedInsertions(empty)).toThrow("stale");
    index.commitPreparedInsertions(plan);
    expect(index.size).toBe(1);
  });

  it("validates duplicates and malformed later entries before mutating the index", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("existing", BOUNDS);
    for (const second of [
      { bounds: BOUNDS, id: "new" },
      { bounds: BOUNDS, id: "existing" },
      { bounds: { ...BOUNDS, maxX: NaN }, id: "bad" },
    ]) {
      expect(() => index.prepareInsertions([{ bounds: BOUNDS, id: "new" }, second])).toThrow();
      expect(index.size).toBe(1);
      expect(index.membershipCount).toBe(1);
    }
  });

  it("rejects aggregate overflow capacity before inserting any item", () => {
    const index = new UniformSpatialIndex<number>();
    const bounds = { ...BOUNDS, maxX: 100_000 };
    index.insertMany(Array.from({ length: MAX_OVERFLOW_ELEMENTS }, (_, id) => ({ bounds, id })));
    expect(() =>
      index.prepareInsertions([
        { bounds: BOUNDS, id: MAX_OVERFLOW_ELEMENTS },
        { bounds, id: MAX_OVERFLOW_ELEMENTS + 1 },
      ]),
    ).toThrow("overflow");
    expect(index.size).toBe(MAX_OVERFLOW_ELEMENTS);
    expect(index.membershipCount).toBe(0);
  });

  it("rejects exhausted record versions during preparation", () => {
    const preparation = new SpatialInsertionPreparation<string>();
    expect(() =>
      preparation.prepare([{ bounds: BOUNDS, id: "new" }], {
        currentMemberships: 0,
        currentOverflow: 0,
        generation: 0,
        has: () => false,
        prepareRange: () => ({
          maxCellX: 0,
          maxCellY: 0,
          minCellX: 0,
          minCellY: 0,
          overflow: false,
        }),
        recordVersion: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow("record version");
  });
});
