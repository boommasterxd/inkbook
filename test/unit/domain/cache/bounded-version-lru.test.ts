import { describe, expect, it, vi } from "vitest";

import { BoundedVersionLru } from "../../../../src/domain/cache/bounded-version-lru";

describe("BoundedVersionLru", () => {
  it("enforces both LRU limits and immediately releases stale versions", () => {
    const cache = new BoundedVersionLru<string>(2, 100);
    cache.set("a", 1, "a", 4);
    cache.set("b", 1, "b", 4);
    expect(cache.get("a", 1)).toBe("a");
    cache.set("c", 1, "c", 4);

    expect(cache.get("b", 1)).toBeUndefined();
    expect(cache.statistics()).toMatchObject({ bytes: 8, entries: 2, evictions: 1 });
    expect(cache.get("a", 2)).toBeUndefined();
    expect(cache.statistics()).toMatchObject({ bytes: 4, entries: 1 });

    const byteBounded = new BoundedVersionLru<string>(3, 10);
    byteBounded.set("a", 1, "a", 6);
    byteBounded.set("b", 1, "b", 6);
    expect(byteBounded.get("a", 1)).toBeUndefined();
    expect(byteBounded.statistics()).toMatchObject({ bytes: 6, entries: 1, evictions: 1 });
  });
  it("notifies bounded ownership indexes on replacement, eviction, take, stale reads, and release", () => {
    const removed = vi.fn();
    const cache = new BoundedVersionLru<string>(2, 100, removed);
    cache.set("a", 1, "first", 1);
    cache.set("a", 2, "second", 1);
    expect(removed).toHaveBeenLastCalledWith("a", "first");
    expect(cache.take("a", 2)).toBe("second");
    cache.set("a", 1, "a", 1);
    cache.set("b", 1, "b", 1);
    cache.set("c", 1, "c", 1);
    expect(removed).toHaveBeenLastCalledWith("a", "a");
    expect(cache.get("b", 2)).toBeUndefined();
    expect(removed).toHaveBeenLastCalledWith("b", "b");
    cache.clear();
    expect(removed).toHaveBeenLastCalledWith("c", "c");
    expect(removed).toHaveBeenCalledTimes(5);
  });
});
