import { describe, expect, it } from "vitest";

import type { ArrowElementV1 } from "../../../../src/domain/schema/public";
import { SceneBackgroundCache } from "../../../../src/rendering/scene";
import {
  PATH_CACHE_MAX_BYTES,
  PATH_CACHE_MAX_ENTRIES,
} from "../../../../src/rendering/scene/constants";
import { pathPresentation } from "../../../../src/rendering/scene/element-presentation";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";

describe("scene caches", () => {
  it("enforces the 4,096-entry and 32-MiB recently-unmounted path caps", () => {
    const entryBounded = new ScenePathCache();
    const smallParts = [{ d: "M 0 0 L 1 1", paint: "stroke" }] as const;
    for (let index = 0; index <= PATH_CACHE_MAX_ENTRIES; index += 1) {
      entryBounded.retain(`entry-${String(index)}`, 1, smallParts);
    }

    expect(PATH_CACHE_MAX_ENTRIES).toBe(4_096);
    expect(PATH_CACHE_MAX_BYTES).toBe(32 * 1_024 * 1_024);
    expect(entryBounded.statistics()).toMatchObject({ entries: 4_096, evictions: 1 });
    expect(entryBounded.take("entry-0", 1)).toBeUndefined();

    const byteBounded = new ScenePathCache();
    const largeParts = [{ d: "M".repeat(5 * 1_024 * 1_024), paint: "stroke" }] as const;
    for (let index = 0; index < 4; index += 1) {
      byteBounded.retain(`large-${String(index)}`, 1, largeParts);
    }
    expect(byteBounded.statistics()).toMatchObject({ entries: 3, evictions: 1 });
    expect(byteBounded.cacheMemoryUsage()).toBeLessThanOrEqual(PATH_CACHE_MAX_BYTES);
  });

  it("reuses background geometry for unchanged aligned indices", () => {
    const cache = new SceneBackgroundCache();
    const first = cache.resolve({
      background: { spacing: 20, type: "squares" },
      innerWidth: 2000,
      margin: 24.3,
      visibleBottom: 300,
      visibleTop: 100,
      writableBottom: 1_024.3,
    });
    const second = cache.resolve({
      background: { spacing: 20, type: "squares" },
      innerWidth: 2000,
      margin: 24.3,
      visibleBottom: 301,
      visibleTop: 101,
      writableBottom: 1_024.3,
    });

    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(second.d).toBe(first.d);
    expect(cache.builds).toBe(1);
  });

  it("keeps tall dotted background geometry bounded", () => {
    const cache = new SceneBackgroundCache();
    const result = cache.resolve({
      background: { spacing: 20, type: "dots" },
      innerWidth: 2000,
      margin: 24.3,
      visibleBottom: 900_000,
      visibleTop: 0,
      writableBottom: 900_024.3,
    });

    expect(result.d.length).toBeLessThan(200);
    expect(result.d.match(/M /g)).toHaveLength(1);
    expect(cache.builds).toBe(1);
  });

  it("keeps the patterned coverage inside the writable SVG margins", () => {
    const cache = new SceneBackgroundCache();
    const result = cache.resolve({
      background: { spacing: 100, type: "lines" },
      innerWidth: 2000,
      margin: 24.3,
      visibleBottom: 500,
      visibleTop: 0,
      writableBottom: 324.3,
    });

    expect(result.d).toBe("M 24.3 24.3 H 2024.3 V 324.3 H 24.3 Z");
    expect(result.lastVisibleIndex).toBe(3);
  });

  it("collapses placeholder-height coverage instead of inverting the top margin", () => {
    const cache = new SceneBackgroundCache();
    const result = cache.resolve({
      background: { spacing: 100, type: "lines" },
      innerWidth: 2000,
      margin: 24.3,
      visibleBottom: 1,
      visibleTop: 0,
      writableBottom: -23.3,
    });

    expect(result.d).toBe("M 24.3 24.3 H 2024.3 V 24.3 H 24.3 Z");
  });
});

describe("active SVG presentation parity", () => {
  it("fills arrow node subpaths with outline paint and opacity", () => {
    const arrow: ArrowElementV1 = {
      bend: null,
      createdAt: 0,
      end: { x: 100, y: 0 },
      endConnection: null,
      endNode: "triangle",
      id: "arrow",
      kind: "arrow",
      pivot: { x: 50, y: 0 },
      rotation: 0,
      start: { x: 0, y: 0 },
      startConnection: null,
      startNode: "none",
      style: {
        outlineColor: { type: "rgba", value: "#112233FF" },
        outlineOpacity: 0.4,
        outlineStyle: "solid",
        outlineWidth: 4,
      },
    };

    const presentation = pathPresentation(arrow, { d: "M 0 0 Z", paint: "fill" });

    expect(presentation.fill).toBe("#112233FF");
    expect(presentation["fill-opacity"]).toBe("0.4");
    expect(presentation.stroke).toBe("none");
  });
});
