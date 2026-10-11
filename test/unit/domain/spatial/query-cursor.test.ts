import { describe, expect, it } from "vitest";

import { SpatialQueryScratch, UniformSpatialIndex } from "../../../../src/domain/spatial";
import type { SpatialQueryCursor } from "../../../../src/domain/spatial/query-cursor";

const BOUNDS = { minX: 0, minY: 0, maxX: 300, maxY: 20 };

function collect<Id>(cursor: SpatialQueryCursor<Id>, budget = 1): Id[] {
  const ids: Id[] = [];
  for (let steps = 0; steps < 10_000; steps += 1) {
    const step = cursor.advance(budget);
    expect(step.workUnits).toBeLessThanOrEqual(budget);
    expect(step.stale).toBe(false);
    ids.push(...step.ids);
    if (step.done) return ids;
  }
  throw new Error("Query failed to finish.");
}

describe("SpatialQueryCursor", () => {
  it("resumes across duplicate memberships, exact misses and overflow", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("wide", BOUNDS);
    index.insert("miss", { minX: 100, minY: 100, maxX: 110, maxY: 110 });
    index.insert("overflow", { ...BOUNDS, maxX: 100_000 });
    index.insert("overflow-miss", { ...BOUNDS, minY: 100, maxY: 100_000 });
    const cursor = index.beginQuery(BOUNDS);
    expect(collect(cursor)).toEqual(["wide", "overflow"]);
    expect(cursor.advance(1)).toEqual({ ids: [], workUnits: 0, done: true, stale: false });
  });

  it("traverses only occupied columns for enormous sparse ranges", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("origin", BOUNDS);
    index.insert("far", { ...BOUNDS, minX: 1e12, maxX: 1e12 + 20 });
    const cursor = index.beginQuery({ ...BOUNDS, minX: -1e12, maxX: 1e12 + 20 });
    const step = cursor.advance(32);
    expect(step.done).toBe(true);
    expect(step.ids).toEqual(["origin", "far"]);
    expect(step.workUnits).toBeLessThanOrEqual(20);
  });

  it("skips unrelated occupied columns and rows", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("origin", BOUNDS);
    index.insert("other-column", { ...BOUNDS, minX: 1e12, maxX: 1e12 + 20 });
    index.insert("other-row", { ...BOUNDS, minY: 1e12, maxY: 1e12 + 20 });
    expect(collect(index.beginQuery({ ...BOUNDS, maxX: 100_000 }))).toEqual(["origin"]);
  });

  it("charges missing columns and cells in a compact coordinate range", () => {
    const index = new UniformSpatialIndex<number>();
    for (let id = 0; id < 8; id += 1) {
      index.insert(id, { minX: id * 512, maxX: id * 512 + 1, minY: 0, maxY: 1 });
    }
    expect(collect(index.beginQuery({ minX: 0, maxX: 700, minY: 0, maxY: 300 }))).toEqual([0, 1]);
  });

  it("copies caller bounds and keeps independent queries", () => {
    const index = new UniformSpatialIndex<number>();
    index.insert(1, BOUNDS);
    const bounds = { ...BOUNDS };
    const first = index.beginQuery(bounds);
    bounds.minY = 100;
    bounds.maxY = 200;
    expect(collect(index.beginQuery(bounds))).toEqual([]);
    expect(collect(first)).toEqual([1]);
  });

  it.each(["insert", "replace", "remove"] as const)(
    "invalidates on %s before slot reuse",
    (kind) => {
      const index = new UniformSpatialIndex<number>();
      index.insert(1, BOUNDS);
      const cursor = index.beginQuery(BOUNDS);
      cursor.advance(1);
      if (kind === "insert") index.insert(2, BOUNDS);
      if (kind === "replace") index.replace(1, { ...BOUNDS, maxX: 400 });
      if (kind === "remove") {
        index.remove(1);
        index.insert(2, BOUNDS);
      }
      expect(cursor.advance(100)).toEqual({ ids: [], workUnits: 0, done: true, stale: true });
      expect(cursor.advance(1).stale).toBe(true);
    },
  );

  it("cancels idempotently and ignores later mutations", () => {
    const index = new UniformSpatialIndex<number>();
    index.insert(1, BOUNDS);
    const cursor = index.beginQuery(BOUNDS);
    cursor.advance(3);
    cursor.cancel();
    cursor.cancel();
    index.remove(1);
    expect(cursor.advance(1)).toEqual({ ids: [], workUnits: 0, done: true, stale: false });
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid work budget %s",
    (budget) => {
      const cursor = new UniformSpatialIndex<number>().beginQuery(BOUNDS);
      expect(() => cursor.advance(budget)).toThrow(RangeError);
      expect(collect(cursor)).toEqual([]);
    },
  );

  it("rejects invalid bounds before starting", () => {
    const index = new UniformSpatialIndex<number>();
    expect(() => index.beginQuery({ ...BOUNDS, minX: NaN })).toThrow(TypeError);
  });
});

describe("axis-aware query ownership and order", () => {
  it.each([
    { axis: "columns", reversed: false },
    { axis: "columns", reversed: true },
    { axis: "rows", reversed: false },
    { axis: "rows", reversed: true },
  ])(
    "retains negative $axis bucket and overflow order with reversed=$reversed",
    ({ axis, reversed }) => {
      const index = new UniformSpatialIndex<string>();
      index.insert("overflow", { minX: -1e8, minY: -1e8, maxX: 1e8, maxY: 1e8 });
      const positions = reversed ? [-256, -768, -512] : [-512, -768, -256];
      const expected = positions.map((position) => String(position));
      for (const position of positions) {
        index.insert(String(position), {
          minX: axis === "columns" ? position : -255,
          maxX: axis === "columns" ? position + 1 : -254,
          minY: axis === "rows" ? position : -255,
          maxY: axis === "rows" ? position + 1 : -254,
        });
      }
      const bounds = {
        minX: axis === "columns" ? -1e7 : -255,
        maxX: axis === "columns" ? 0 : -254,
        minY: axis === "rows" ? -1e7 : -255,
        maxY: axis === "rows" ? 0 : -254,
      };
      const scratch = new SpatialQueryScratch<string>();
      expect(index.query(bounds, scratch)).toBe(4);
      expect(Array.from({ length: scratch.count }, (_, offset) => scratch.at(offset))).toEqual([
        ...expected,
        "overflow",
      ]);
      expect(collect(index.beginQuery(bounds))).toEqual([...expected, "overflow"]);
      scratch.release();
    },
  );

  it.each(["stale", "cancelled"])("releases %s queries with both axis states suspended", (mode) => {
    const index = new UniformSpatialIndex<number>();
    index.insert(0, { minX: 1, minY: 1, maxX: 2, maxY: 2 });
    index.insert(1, { minX: 1e12, minY: 1, maxX: 1e12 + 1, maxY: 2 });
    const cursor = index.beginQuery({ minX: 1, maxX: 2, minY: 1, maxY: 1e12 });
    expect(cursor.advance(2).ids).toEqual([]);
    expect(cursor.memoryUsage()).toBeGreaterThanOrEqual(512);
    if (mode === "stale") index.remove(0);
    else cursor.cancel();
    expect(cursor.advance(64)).toEqual({
      ids: [],
      workUnits: 0,
      done: true,
      stale: mode === "stale",
    });
    expect(cursor.memoryUsage()).toBe(0);
  });
});
