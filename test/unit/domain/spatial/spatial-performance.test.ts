import { describe, expect, it, vi } from "vitest";

import { SpatialQueryScratch, UniformSpatialIndex } from "../../../../src/domain/spatial";

import { SpatialQueryCursor } from "../../../../src/domain/spatial/query-cursor";
import type { IndexedEntry } from "../../../../src/domain/spatial/index-state";

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

  it("deduplicates after growth, epoch wrap, slot reuse and release", () => {
    const scratch = new SpatialQueryScratch<string>();
    scratch.begin(1);
    scratch.visit(0, "initial", true);
    scratch.visit(0, "duplicate", true);
    expect(scratch.count).toBe(1);
    expect(scratch.duplicateVisitCount).toBe(1);
    scratch.begin(17);
    scratch.visit(0, "reused", true);
    scratch.visit(16, "outside", false);
    scratch.visit(16, "duplicate outside", true);
    expect(scratch.count).toBe(1);
    expect(scratch.at(0)).toBe("reused");
    expect(scratch.candidateVisitCount).toBe(3);
    expect(scratch.duplicateVisitCount).toBe(1);
    expect(() => scratch.at(1)).toThrow(RangeError);
    const state = scratch as unknown as { epoch: number; markers: Uint32Array };
    state.markers[0] = 1;
    state.epoch = 0xffff_ffff;
    scratch.begin(17);
    scratch.visit(0, "wrapped", true);
    expect(scratch.at(0)).toBe("wrapped");
    expect(scratch.duplicateVisitCount).toBe(0);
    state.epoch = 0xffff_ffff;
    scratch.begin(33);
    scratch.visit(0, "grown after wrap", true);
    expect(scratch.at(0)).toBe("grown after wrap");
    scratch.release();
    expect(() => scratch.at(0)).toThrow(RangeError);
    expect(scratch.markerCapacity).toBe(0);
    scratch.begin(1);
    scratch.visit(0, "after release", true);
    expect(scratch.at(0)).toBe("after release");
    expect(scratch.duplicateVisitCount).toBe(0);
    scratch.release();
  });
});

describe("resumable spatial query work", () => {
  it("bounds actual bucket visits and slot reads across 10,000 overlapping elements", () => {
    const bounds = { minX: 0, minY: 0, maxX: 300, maxY: 20 };
    const slots: IndexedEntry<number>[] = Array.from({ length: 10_000 }, (_, id) => ({
      ...bounds,
      cellKeys: [0, 0, 1, 0],
      id,
      overflow: false,
      recordVersion: id,
      slot: id,
    }));
    const bucket = new Set(slots.map((entry) => entry.slot));
    let visits = 0;
    let reads = 0;
    const iterate = bucket[Symbol.iterator].bind(bucket);
    vi.spyOn(bucket, Symbol.iterator).mockImplementation(function* (): Generator<
      number,
      undefined
    > {
      for (const slot of iterate()) {
        visits += 1;
        yield slot;
      }
      return undefined;
    });
    const source = {
      cells: new Map([
        [0, new Map([[0, bucket]])],
        [1, new Map([[0, bucket]])],
      ]),
      generation: () => 0,
      overflowSlots: new Set<number>(),
      slots: new Proxy(slots, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
    };
    const range = { minCellX: 0, minCellY: 0, maxCellX: 1, maxCellY: 0, overflow: false };
    const cursor = new SpatialQueryCursor(source, range, bounds);
    expect(visits).toBe(0);
    expect(reads).toBe(0);
    const ids = new Set<number>();
    let done = false;
    let totalVisits = 0;
    let totalReads = 0;
    while (!done) {
      visits = 0;
      reads = 0;
      const step = cursor.advance(64);
      expect(visits).toBeLessThanOrEqual(64);
      expect(reads).toBeLessThanOrEqual(64);
      expect(step.workUnits).toBeLessThanOrEqual(64);
      expect(visits).toBeLessThanOrEqual(step.workUnits);
      for (const id of step.ids) ids.add(id);
      totalVisits += visits;
      totalReads += reads;
      done = step.done;
    }
    expect(ids.size).toBe(10_000);
    expect(totalVisits).toBe(20_000);
    expect(totalReads).toBe(10_000);
    visits = 0;
    reads = 0;
    cursor.advance(64);
    expect(visits + reads).toBe(0);
    const cancelled = new SpatialQueryCursor(source, range, bounds);
    cancelled.advance(64);
    cancelled.cancel();
    visits = 0;
    reads = 0;
    cancelled.advance(64);
    expect(visits + reads).toBe(0);
  });
});
