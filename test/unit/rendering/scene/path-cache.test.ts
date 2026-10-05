import { describe, expect, it, vi } from "vitest";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { BoundedVersionLru } from "../../../../src/domain/cache/bounded-version-lru";
import * as geometry from "../../../../src/domain/geometry/element-path";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";
import {
  pressureWindowRetainedBytes,
  type PressureWindow,
} from "../../../../src/domain/geometry/pressure-window";

function immutableStroke() {
  const stroke = createTestStroke();
  Object.freeze(stroke.points);
  return stroke;
}

describe("scene-owned immutable stroke reuse", () => {
  it("reuses actual geometry across paint and identity changes and shares prepared windows", () => {
    const build = vi.spyOn(geometry, "buildElementPathParts");
    try {
      const cache = new ScenePathCache();
      const stroke = immutableStroke();
      const first = cache.build(stroke);
      const published = new Map<number, PressureWindow>();
      const second = cache.build(
        { ...stroke, id: "another-stroke", style: { ...stroke.style, opacity: 0.4 } },
        {
          readWindow: () => undefined,
          publishWindow: (index, window) => {
            published.set(index, window);
          },
        },
      );
      expect(second).toBe(first);
      expect(build).toHaveBeenCalledTimes(1);
      expect(published.size).toBe(1);
      expect(cache.cacheMemoryUsage()).toBeGreaterThan(
        stroke.points.length * 8 + pressureWindowRetainedBytes(published.get(0)!),
      );
      cache.release();
      expect(cache.cacheMemoryUsage()).toBe(0);
      expect(cache.build(stroke)).not.toBe(first);
    } finally {
      build.mockRestore();
    }
  });

  it("rebuilds mutable external samples and every geometry-changing parameter", () => {
    const cache = new ScenePathCache();
    const mutable = createTestStroke();
    const first = cache.build(mutable);
    mutable.points[3] = 40;
    expect(cache.build(mutable)).not.toEqual(first);
    const stroke = immutableStroke();
    const original = cache.build(stroke);
    const variants = [
      { ...stroke, style: { ...stroke.style, width: 4 as const } },
      { ...stroke, style: { ...stroke.style, pressureEnabled: false } },
      { ...stroke, rotation: 45 },
      { ...stroke, pivot: { x: 30, y: 40 } },
      { ...stroke, tool: "highlighter" as const },
    ];
    for (const variant of variants) expect(cache.build(variant)).not.toBe(original);
    expect(cache.build(stroke)).toBe(original);
  });
});

describe("scene geometry identity and alias ownership", () => {
  it("touches identical contours and versioned aliases without replacing LRU entries", () => {
    const cache = new ScenePathCache();
    const stroke = immutableStroke();
    const parts = cache.build(stroke);
    cache.retain(stroke.id, 1, parts);
    const bytes = cache.cacheMemoryUsage();
    const set = vi.spyOn(BoundedVersionLru.prototype, "set");
    try {
      cache.retain(stroke.id, 1, parts);
      cache.retain(stroke.id, 1, parts);
      expect(set).not.toHaveBeenCalled();
      expect(cache.cacheMemoryUsage()).toBe(bytes);
      cache.retain(stroke.id, 2, parts);
      expect(set).toHaveBeenCalledOnce();
      expect(cache.take(stroke.id, 1)).toBeUndefined();
      expect(cache.take(stroke.id, 2)).toBe(parts);
      cache.release();
      expect(cache.cacheMemoryUsage()).toBe(0);
    } finally {
      set.mockRestore();
    }
  });

  it("retains repeated completion once and preserves the current identity through eviction", () => {
    const cache = new ScenePathCache(1, 1024 * 1024);
    const stroke = immutableStroke();
    const parts = geometry.buildElementPathParts(stroke);
    cache.completePreparation(stroke, parts);
    cache.completePreparation(stroke, [...parts]);
    expect(cache.statistics()).toMatchObject({ entries: 1, evictions: 0 });
    expect(cache.read(stroke)).toBe(parts);
    const changed = { ...stroke, style: { ...stroke.style, width: 4 as const } };
    const replacement = cache.build(changed);
    expect(cache.statistics()).toMatchObject({ entries: 1, evictions: 1 });
    expect(cache.read(changed)).toBe(replacement);
    expect(cache.read(stroke)).toBeUndefined();
  });

  it("shares one contour across geometry identity and ID/version aliases", () => {
    const cache = new ScenePathCache();
    const stroke = immutableStroke();
    const parts = cache.build(stroke);
    const originalBytes = cache.cacheMemoryUsage();
    cache.retain(stroke.id, 1, parts);
    cache.retain("copied", 2, parts);
    expect(cache.has(stroke.id, 1)).toBe(true);
    expect(cache.has(stroke.id, 1)).toBe(true);
    expect(cache.statistics().entries).toBe(1);
    expect(cache.cacheMemoryUsage() - originalBytes).toBeLessThan(512);
    expect(cache.take(stroke.id, 1)).toBe(parts);
    expect(cache.take(stroke.id, 1)).toBe(parts);
    expect(cache.take("copied", 1)).toBeUndefined();
    expect(cache.read(stroke)).toBe(parts);
    cache.retain("copied", 3, parts);
    cache.invalidate("copied");
    expect(cache.take("copied", 3)).toBeUndefined();
    expect(cache.read(stroke)).toBe(parts);
    cache.release();
    expect(cache.cacheMemoryUsage()).toBe(0);
    cache.retain(stroke.id, 4, parts);
    expect(cache.statistics().entries).toBe(1);
    expect(cache.take(stroke.id, 4)).toBe(parts);
  });
});

describe("scene geometry alias invalidation", () => {
  it("releases the final ID owner synchronously while preserving contours shared by another ID", () => {
    const cache = new ScenePathCache();
    const stroke = immutableStroke();
    const copied = { ...stroke, id: "copy" };
    const parts = cache.build(stroke);
    expect(cache.build(copied)).toBe(parts);
    cache.invalidate(stroke.id);
    expect(cache.statistics().entries).toBe(1);
    expect(cache.read(copied)).toBe(parts);
    cache.retain(stroke.id, 1, parts);
    cache.retain(copied.id, 1, parts);
    expect(cache.take(stroke.id, 1)).toBe(parts);
    cache.invalidate(stroke.id);
    expect(cache.statistics().entries).toBe(1);
    expect(cache.take(copied.id, 1)).toBe(parts);
    cache.invalidate(copied.id);
    expect(cache.statistics().entries).toBe(0);
    expect(cache.cacheMemoryUsage()).toBe(0);
    expect(cache.read(copied)).toBeUndefined();
  });

  it("releases a completed stroke before any viewport exit and after stale-version probes", () => {
    const cache = new ScenePathCache();
    const stroke = immutableStroke();
    const parts = geometry.buildElementPathParts(stroke);
    cache.completePreparation(stroke, parts);
    cache.invalidate(stroke.id);
    expect(cache.statistics().entries).toBe(0);
    expect(cache.cacheMemoryUsage()).toBe(0);
    cache.retain(stroke.id, 2, parts);
    expect(cache.has(stroke.id, 1)).toBe(false);
    expect(cache.take(stroke.id, 1)).toBeUndefined();
    cache.invalidate(stroke.id);
    expect(cache.statistics().entries).toBe(0);
    expect(cache.cacheMemoryUsage()).toBe(0);
  });
});

describe("scene stroke reuse resource ownership", () => {
  it("uses the existing entry and byte limits and releases identity lookups on memory pressure", () => {
    const cache = new ScenePathCache(1, 1024 * 1024);
    const stroke = immutableStroke();
    const original = cache.build(stroke);
    cache.build({ ...stroke, style: { ...stroke.style, width: 4 } });
    expect(cache.statistics().entries).toBe(1);
    expect(cache.build(stroke)).not.toBe(original);
    cache.setRetentionEnabled(false);
    expect(cache.cacheMemoryUsage()).toBe(0);
    const uncached = cache.build(stroke);
    expect(cache.build(stroke)).not.toBe(uncached);
    cache.setRetentionEnabled(true);
    const retained = cache.build(stroke);
    expect(cache.build(stroke)).toBe(retained);
    const tooSmall = new ScenePathCache(1, 1);
    expect(tooSmall.build(stroke)).not.toBe(tooSmall.build(stroke));
    expect(tooSmall.statistics().entries).toBe(0);
  });

  it("does not publish stale identity lookups when window publication disables retention", () => {
    const cache = new ScenePathCache();
    const stroke = immutableStroke();
    cache.build(stroke, {
      readWindow: () => undefined,
      publishWindow: () => {
        cache.setRetentionEnabled(false);
      },
    });
    expect(cache.statistics().entries).toBe(0);
    expect(cache.cacheMemoryUsage()).toBe(0);
    const lookups = vi.spyOn(
      cache as unknown as {
        getCached(id: string, version: number): unknown;
      },
      "getCached",
    );
    try {
      cache.setRetentionEnabled(true);
      const rebuilt = cache.build(stroke);
      // No lookup is attempted for a geometry that was never retained.
      expect(lookups).not.toHaveBeenCalled();
      expect(cache.build(stroke)).toBe(rebuilt);
      expect(lookups).toHaveBeenCalledTimes(1);
    } finally {
      lookups.mockRestore();
    }
  });

  it("accepts store-owned packed points but rejects mutable external typed arrays", async () => {
    const source = createTestStroke();
    const { stroke } = await hydrateRuntimeStroke(source);
    const cache = new ScenePathCache();
    expect(cache.build(stroke)).toBe(cache.build(stroke));
    const external = {
      ...source,
      points: new Float64Array(source.points),
    } as unknown as typeof source;
    expect(cache.build(external)).not.toBe(cache.build(external));
  });
});

it("reuses local pressure paths across durable moves without publishing world geometry", () => {
  const cache = new ScenePathCache();
  const stroke = { ...immutableStroke(), rotation: 37 };
  const parts = cache.build(stroke);
  const pressure = { readWindow: vi.fn(), publishWindow: vi.fn(), readPath: vi.fn() };
  const moved = {
    ...stroke,
    offset: { x: 100, y: 50 },
    pivot: { x: stroke.pivot.x + 100, y: stroke.pivot.y + 50 },
  };
  expect(cache.build(moved, pressure)).toBe(parts);
  expect(pressure.readWindow).not.toHaveBeenCalled();
  expect(pressure.publishWindow).not.toHaveBeenCalled();
  expect(pressure.readPath).not.toHaveBeenCalled();
  expect(cache.build(stroke)).toBe(parts);
  cache.release();
  expect(cache.build(moved, pressure)).toEqual(parts);
  expect(pressure.publishWindow).not.toHaveBeenCalled();
});
