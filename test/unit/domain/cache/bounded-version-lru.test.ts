import { describe, expect, it } from "vitest";

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
});
