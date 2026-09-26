import { describe, expect, it, vi } from "vitest";
import { SelectionCenterCache } from "../../../../src/rendering/scene/selection-center-cache";
import * as strokePath from "../../../../src/domain/geometry/stroke-path";
import { indexedStroke } from "../../../fixtures/editor/stroke";

describe("selection center cache", () => {
  it("reuses immutable centers across paint changes and rejects geometry changes", () => {
    const cache = new SelectionCenterCache();
    const stroke = indexedStroke(0);
    const path = cache.build(stroke);
    expect(cache.read({ ...stroke, style: { ...stroke.style, opacity: 0.5 } })).toBe(path);
    for (const changed of [
      { ...stroke, points: stroke.points.slice() },
      { ...stroke, rotation: stroke.rotation + 1 },
      { ...stroke, pivot: { ...stroke.pivot, x: stroke.pivot.x + 1 } },
      { ...stroke, pivot: { ...stroke.pivot, y: stroke.pivot.y + 1 } },
      { ...stroke, style: { ...stroke.style, width: 4 as const } },
    ]) {
      cache.build(stroke);
      expect(cache.read(changed)).toBeUndefined();
      expect(cache.memoryUsage()).toBe(0);
    }
  });

  it("evicts the least recently used entry at capacity and clears ownership", () => {
    const cache = new SelectionCenterCache();
    const strokes = Array.from({ length: 4097 }, (_, i) => indexedStroke(i));
    for (const stroke of strokes.slice(0, 4096)) cache.build(stroke);
    expect(cache.read(strokes[0]!)).toBeDefined();
    cache.build(strokes[4096]!);
    expect(cache.read(strokes[1]!)).toBeUndefined();
    expect(cache.read(strokes[0]!)).toBeDefined();
    expect(cache.memoryUsage()).toBeLessThanOrEqual(2 * 1024 * 1024);
    cache.clear();
    expect(cache.memoryUsage()).toBe(0);
    expect(cache.read(strokes[0]!)).toBeUndefined();
  });

  it("rejects oversized strings and evicts by bytes independently of entry count", () => {
    const builder = vi.spyOn(strokePath, "buildStrokePathParts");
    try {
      const cache = new SelectionCenterCache();
      builder.mockReturnValue([{ d: "M".repeat(600_000), paint: "stroke" }]);
      const first = indexedStroke(0);
      const second = indexedStroke(1);
      cache.build(first);
      cache.build(second);
      expect(cache.read(first)).toBeUndefined();
      expect(cache.read(second)).toBeDefined();
      builder.mockReturnValue([{ d: "M".repeat(1_100_000), paint: "stroke" }]);
      cache.build(second);
      expect(cache.read(second)).toBeUndefined();
      expect(cache.memoryUsage()).toBe(0);
    } finally {
      builder.mockRestore();
    }
  });
});
