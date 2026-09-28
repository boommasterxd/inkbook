import { describe, expect, it, vi } from "vitest";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
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
