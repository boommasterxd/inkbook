import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { SemanticAnchorCache } from "../../../../src/domain/store/semantic-anchor-cache";

import { IDS, rectangle } from "./fixtures";

describe("SemanticAnchorCache", () => {
  it("records misses and hits by geometry version without rebuilding for paint changes", () => {
    const cache = new SemanticAnchorCache();
    const source = rectangle();
    const first = cache.resolve(source.id, 1, source);
    const paintOnlyTarget = rectangle();
    paintOnlyTarget.style = { ...paintOnlyTarget.style, outlineOpacity: 0.5 };
    const paintOnly = cache.resolve(source.id, 1, paintOnlyTarget);
    const geometry = cache.resolve(source.id, 2, { ...source, width: 240 });

    expect(first.hit).toBe(false);
    expect(paintOnly.hit).toBe(true);
    expect(paintOnly.anchors).toBe(first.anchors);
    expect(geometry.hit).toBe(false);
    expect(geometry.anchors).not.toBe(first.anchors);
    expect(cache.statistics()).toMatchObject({ builds: 2, entries: 1, hits: 1 });
  });

  it("evicts the least recently used target and explicitly invalidates removed IDs", () => {
    const cache = new SemanticAnchorCache(2, 10_000);
    const a = rectangle("a");
    const b = rectangle("b");
    const c = rectangle("c");
    cache.resolve(a.id, 1, a);
    cache.resolve(b.id, 1, b);
    expect(cache.resolve(a.id, 1, a).hit).toBe(true);
    cache.resolve(c.id, 1, c);

    cache.invalidate(a.id);
    expect(cache.statistics()).toMatchObject({ entries: 1, evictions: 1 });
    expect(cache.resolve(a.id, 1, a).hit).toBe(false);
  });
});

describe("ElementStore semantic anchor ownership", () => {
  it("preserves cached anchors for paint and removes them with the target", () => {
    const source = rectangle();
    const store = new ElementStore([source]);
    const first = store.getSemanticAnchors(source.id);
    const paintOnly = rectangle();
    paintOnly.style = { ...paintOnly.style, fillOpacity: 0.5 };
    store.replace(source.id, paintOnly);

    expect(store.getSemanticAnchors(source.id)).toBe(first);
    expect(store.instrumentation).toMatchObject({
      anchorBuilds: 1,
      anchorCacheEntries: 1,
      anchorCacheHits: 1,
    });

    store.remove([source.id]);
    expect(store.getSemanticAnchors(source.id)).toBeNull();
    expect(store.instrumentation.anchorCacheEntries).toBe(0);
    store.create(rectangle(IDS.target, 300, 100));
    expect(store.getSemanticAnchors(source.id)?.[0]?.point.x).toBe(300);
    expect(store.instrumentation.anchorBuilds).toBe(2);
  });

  it("evicts and suppresses anchor retention under active-document memory pressure", () => {
    const source = rectangle();
    const store = new ElementStore([source]);
    store.getSemanticAnchors(source.id);
    expect(store.instrumentation.estimatedRetainedBytes).toBeGreaterThan(0);
    expect(store.instrumentation).toMatchObject({
      anchorCacheEntries: 1,
    });

    store.setActiveDocumentMemoryPressure(true);
    expect(store.instrumentation).toMatchObject({
      anchorCacheEntries: 0,
      anchorCacheEvictions: 1,
    });
    store.getSemanticAnchors(source.id);
    expect(store.instrumentation).toMatchObject({
      anchorBuilds: 2,
      anchorCacheEntries: 0,
    });

    store.setActiveDocumentMemoryPressure(false);
    store.getSemanticAnchors(source.id);
    expect(store.instrumentation.anchorCacheEntries).toBe(1);
  });
});
