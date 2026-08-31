import { describe, expect, it } from "vitest";

import {
  MAX_EXTENT_REBUILD_SLICE,
  MAX_STALE_EXTENT_POPS,
  UniformSpatialIndex,
} from "../../../../src/domain/spatial";

function boundsAt(bottom: number) {
  return { maxX: 10, maxY: bottom, minX: 0, minY: bottom - 10 };
}

describe("UniformSpatialIndex page extent values", () => {
  it("returns the greatest grid bottom and shrinks after deletion", () => {
    const index = new UniformSpatialIndex<string>();
    expect(index.getMaximumBottom()).toBeUndefined();
    index.insert("low", boundsAt(100));
    index.insert("high", boundsAt(500));
    index.insert("middle", boundsAt(300));

    expect(index.getMaximumBottom()).toBe(500);
    expect(index.remove("high")).toBe(true);
    expect(index.getMaximumBottom()).toBe(300);
    expect(index.lastExtentStalePops).toBe(1);
    expect(index.extentCleanupPending).toBe(false);
  });

  it("compares grid heap and bounded overflow maxima", () => {
    const index = new UniformSpatialIndex<string>();
    const overflowAt = (bottom: number) => ({
      maxX: 1_000_000,
      maxY: bottom,
      minX: 0,
      minY: bottom - 1_000_000,
    });
    index.insert("grid", boundsAt(500));
    index.insert("overflow-low", overflowAt(400));
    index.insert("overflow-high", overflowAt(900));

    expect(index.getMaximumBottom()).toBe(900);
    index.replace("overflow-high", overflowAt(100));
    expect(index.getMaximumBottom()).toBe(500);
    index.remove("grid");
    expect(index.getMaximumBottom()).toBe(400);
    index.remove("overflow-low");
    expect(index.getMaximumBottom()).toBe(100);
  });

  it("never revalidates old heap entries after reusing an ID and slot", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("reused", boundsAt(1_000));
    index.remove("reused");
    index.insert("reused", boundsAt(100));

    expect(index.getMaximumBottom()).toBe(100);
    expect(index.lastExtentStalePops).toBe(0);
    expect(index.extentHeapEntryCount).toBe(1);
  });

  it("retains an equal replacement maximum after bubbling through lower entries", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("maximum", boundsAt(500));
    index.insert("low", boundsAt(100));
    index.insert("middle", boundsAt(200));

    index.replace("maximum", boundsAt(500));

    expect(index.getMaximumBottom()).toBe(500);
    expect(index.lastExtentStalePops).toBe(1);
  });
});

describe("UniformSpatialIndex page extent maintenance", () => {
  it("automatically compacts repeated replacements in bounded operation slices", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("moving", boundsAt(1_000));
    for (let bottom = 999; bottom >= 700; bottom -= 1) index.replace("moving", boundsAt(bottom));

    expect(index.getMaximumBottom()).toBe(700);
    expect(index.lastExtentStalePops).toBeLessThanOrEqual(MAX_STALE_EXTENT_POPS);
    expect(index.extentCleanupPending).toBe(false);
    expect(index.extentHeapEntryCount).toBeLessThanOrEqual(2);
  });

  it("keeps the extent heap bounded over many production replacements", () => {
    const index = new UniformSpatialIndex<string>();
    index.insert("moving", boundsAt(1_300));
    for (let update = 0; update < 10_000; update += 1) {
      index.replace("moving", boundsAt(1_299 - update));
    }

    expect(index.getMaximumBottom()).toBe(1_299 - 9_999);
    expect(index.extentHeapEntryCount).toBeLessThanOrEqual(2);
    expect(index.beginExtentRebuild()).toBe(false);
  });

  it("adopts geometry changes while an automatic incremental rebuild is active", () => {
    const index = new UniformSpatialIndex<string>();
    for (let id = 0; id < 500; id += 1) index.insert(`element-${id}`, boundsAt(id));
    for (let update = 0; update < 501; update += 1) {
      index.replace("element-0", boundsAt(1_000 + update));
    }
    expect(index.beginExtentRebuild()).toBe(false);
    index.replace("element-499", boundsAt(2_000));

    expect(index.getMaximumBottom()).toBe(2_000);
  });

  it("validates rebuild slice limits and reports an idle rebuild", () => {
    const index = new UniformSpatialIndex<string>();

    expect(index.rebuildExtentStep()).toBe(false);
    expect(() => index.rebuildExtentStep(0)).toThrow(RangeError);
    expect(() => index.rebuildExtentStep(MAX_EXTENT_REBUILD_SLICE + 1)).toThrow(RangeError);
  });
});
