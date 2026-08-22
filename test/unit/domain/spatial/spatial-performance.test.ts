import { describe, expect, it } from "vitest";

import { SpatialQueryScratch, UniformSpatialIndex } from "../../../../src/domain/spatial";

describe("spatial index steady-state instrumentation", () => {
  it("reuses query result and epoch-marker allocations for a 10,000-element fixture", () => {
    const index = new UniformSpatialIndex<number>();
    for (let id = 0; id < 10_000; id += 1) {
      const column = id % 100;
      const row = Math.floor(id / 100);
      const x = column * 512 + 1;
      const y = row * 512 + 1;
      index.insert(id, { maxX: x + 20, maxY: y + 20, minX: x, minY: y });
    }

    const scratch = new SpatialQueryScratch<number>();
    const viewport = { maxX: 2_100, maxY: 2_100, minX: 0, minY: 0 };
    expect(index.query(viewport, scratch)).toBe(25);
    const warmAllocationCount = scratch.allocationCount;
    expect(warmAllocationCount).toBeGreaterThan(0);

    for (let query = 0; query < 1_000; query += 1) {
      expect(index.query(viewport, scratch)).toBe(25);
    }

    expect(scratch.allocationCount).toBe(warmAllocationCount);
    expect(scratch.candidateVisitCount).toBe(25);
    expect(scratch.duplicateVisitCount).toBe(0);
    expect(scratch.markerCapacity).toBeGreaterThanOrEqual(10_000);
    expect(scratch.resultCapacity).toBeGreaterThanOrEqual(25);
  });

  it("clears result references before slot reuse and supports explicit scratch release", () => {
    const first = { id: "first" };
    const second = { id: "second" };
    const index = new UniformSpatialIndex<typeof first>();
    const scratch = new SpatialQueryScratch<typeof first>();
    const bounds = { maxX: 20, maxY: 20, minX: 0, minY: 0 };
    index.insert(first, bounds);
    index.query(bounds, scratch);
    index.remove(first);
    index.insert(second, bounds);

    expect(index.query(bounds, scratch)).toBe(1);
    expect(scratch.at(0)).toBe(second);
    scratch.release();
    expect(scratch.count).toBe(0);
    expect(scratch.markerCapacity).toBe(0);
    expect(scratch.resultCapacity).toBe(0);
  });
});
