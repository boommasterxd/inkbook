import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { PreparedPressureWindowCache } from "../../../../src/domain/store/prepared-pressure-window-cache";
import type { PressureWindow } from "../../../../src/domain/geometry/pressure-window";
import { stroke } from "../schema/fixtures";

function window(segments = 1): PressureWindow {
  return {
    kind: "window",
    additions: [],
    loops: [
      Array.from({ length: segments }, (_, index) => ({
        kind: "line" as const,
        start: { x: index, y: 0 },
        end: { x: index + 1, y: 0 },
      })),
    ],
  };
}

describe("prepared pressure window capacity", () => {
  it("enforces the actual 4096-entry bound and releases evicted invalidation keys", () => {
    const cache = new PreparedPressureWindowCache();
    const value = window();
    for (let index = 0; index < 4097; index += 1)
      cache.publish(`stroke-${String(index)}`, 1, 0, value);
    expect(cache.statistics()).toMatchObject({ entries: 4096, evictions: 1 });
    expect(cache.indexedStrokeCount).toBe(4096);
    expect(cache.read("stroke-0", 1, 0)).toBeUndefined();
    expect(cache.read("stroke-4096", 1, 0)).toBe(value);
    cache.release();
    expect(cache.statistics().bytes).toBe(0);
    expect(cache.indexedStrokeCount).toBe(0);
  });

  it("enforces the actual 8 MiB byte bound before the entry bound", () => {
    const cache = new PreparedPressureWindowCache();
    const value = window(64);
    for (let index = 0; index < 1024; index += 1)
      cache.publish(`stroke-${String(index)}`, 1, 0, value);
    expect(cache.statistics().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(cache.statistics().bytes).toBeGreaterThan(7 * 1024 * 1024);
    expect(cache.statistics().entries).toBeLessThan(1024);
    expect(cache.statistics().evictions).toBeGreaterThan(0);
    expect(cache.indexedStrokeCount).toBe(cache.statistics().entries);
  });

  it("accounts for and freezes approximation additions alongside contour objects", () => {
    const cache = new PreparedPressureWindowCache();
    const first = window();
    cache.publish("a", 1, 0, first);
    const before = cache.statistics().bytes;
    const triangle = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
    ];
    const added = { ...window(), additions: [triangle] };
    cache.publish("a", 1, 0, added);
    expect(cache.statistics().bytes - before).toBeGreaterThan(3 * 16);
    expect(Object.isFrozen(added.additions)).toBe(true);
    expect(Object.isFrozen(triangle)).toBe(true);
    expect(Object.isFrozen(triangle[0])).toBe(true);
  });

  it("replaces versions, invalidates all stroke windows, and rejects invalid or oversized entries", () => {
    const cache = new PreparedPressureWindowCache(4, 4096);
    const value = window();
    cache.publish("a", 1, 0, value);
    cache.publish("a", 1, 1, value);
    cache.publish("a", 2, 0, value);
    expect(cache.read("a", 1, 0)).toBeUndefined();
    expect(cache.read("a", 1, 1)).toBe(value);
    cache.invalidate("a");
    cache.invalidate("missing");
    cache.publish("a", 1, 2, window(100));
    expect(cache.statistics().entries).toBe(0);
    expect(cache.indexedStrokeCount).toBe(0);
    expect(() => cache.read("a", 1, -1)).toThrow(RangeError);
    expect(() => cache.publish("a", 1, NaN, value)).toThrow(RangeError);
  });
});

describe("store-owned prepared pressure windows", () => {
  it("shares paint-only geometry and rejects stale publication after geometry changes or removal", () => {
    const source = stroke();
    const store = new ElementStore([source]);
    const changed = vi.fn();
    const unsubscribe = store.subscribeMemoryUsage(changed);
    const version = store.get(source.id)!.geometryVersion;
    const port = store.pressureGeometry(source.id, version);
    const value = window();
    port.publishWindow(0, value);
    expect(port.readWindow(0)).toBe(value);
    expect(Object.isFrozen(value.loops[0]![0]!.start)).toBe(true);
    expect(store.activeDocumentMemoryUsage().pressureWindowCacheBytes).toBeGreaterThan(0);
    expect(changed).toHaveBeenCalledOnce();
    store.replace(source.id, { ...source, style: { ...source.style, opacity: 0.5 } });
    expect(port.readWindow(0)).toBe(value);
    store.replace(source.id, { ...source, points: [0, 0, 1, 5, 5, 1] });
    port.publishWindow(0, value);
    expect(port.readWindow(0)).toBeUndefined();
    expect(store.activeDocumentMemoryUsage().pressureWindowCacheBytes).toBe(0);
    const current = store.pressureGeometry(source.id, store.get(source.id)!.geometryVersion);
    current.publishWindow(1, value);
    store.remove([source.id]);
    current.publishWindow(1, value);
    expect(current.readWindow(1)).toBeUndefined();
    expect(store.instrumentation.pressureWindowCacheEntries).toBe(0);
    unsubscribe();
  });

  it("isolates stores, disables retention under pressure, and permanently revokes closed-store ports", () => {
    const source = stroke();
    const first = new ElementStore([source]);
    const second = new ElementStore([source]);
    const version = first.get(source.id)!.geometryVersion;
    const port = first.pressureGeometry(source.id, version);
    const value = window();
    port.publishWindow(0, value);
    expect(second.pressureGeometry(source.id, version).readWindow(0)).toBeUndefined();
    first.setActiveDocumentMemoryPressure(true);
    port.publishWindow(0, value);
    expect(port.readWindow(0)).toBeUndefined();
    expect(first.activeDocumentMemoryUsage().pressureWindowCacheBytes).toBe(0);
    first.setActiveDocumentMemoryPressure(false);
    port.publishWindow(0, value);
    expect(port.readWindow(0)).toBe(value);
    first.releasePreparedPressureGeometry();
    first.setActiveDocumentMemoryPressure(false);
    port.publishWindow(0, value);
    expect(port.readWindow(0)).toBeUndefined();
    expect(first.activeDocumentMemoryUsage().pressureWindowCacheBytes).toBe(0);
    first.resetInstrumentation();
    expect(first.instrumentation.pressureWindowCacheHits).toBe(0);
  });
});
