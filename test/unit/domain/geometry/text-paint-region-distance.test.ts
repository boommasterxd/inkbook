import { describe, expect, it } from "vitest";
import { textRegionTouchesSweep } from "../../../../src/domain/geometry/text-paint-region-distance";
import type { TextPaintRegion } from "../../../../src/domain/geometry/text-paint-regions";

const rounded: TextPaintRegion = {
  x: 0,
  y: 0,
  width: 20,
  height: 20,
  roundedClip: { width: 20, height: 20, radius: 10 },
};

describe("text paint region sweep distance", () => {
  it("tests the clipped intersection rather than independent rectangle and circle tolerances", () => {
    const strip = { ...rounded, width: 1 };
    const point = { startX: -1, startY: 0, endX: -1, endY: 0 };
    expect(textRegionTouchesSweep(strip, point, 5)).toBe(false);
    expect(textRegionTouchesSweep(strip, point, 6)).toBe(true);
  });

  it("finds the nearest interior circle-arc point along a swept capsule", () => {
    const sweep = { startX: -10, startY: 10, endX: 10, endY: -10 };
    expect(textRegionTouchesSweep(rounded, sweep, 4)).toBe(false);
    expect(textRegionTouchesSweep(rounded, sweep, 4.2)).toBe(true);
    expect(textRegionTouchesSweep(rounded, { startX: -10, startY: 5, endX: 20, endY: 5 }, 0)).toBe(
      true,
    );
  });

  it("handles interior and boundary points without inventing paint in clipped corners", () => {
    expect(textRegionTouchesSweep(rounded, { startX: 10, startY: 10, endX: 10, endY: 10 }, 0)).toBe(
      true,
    );
    expect(textRegionTouchesSweep(rounded, { startX: 0, startY: 10, endX: 0, endY: 10 }, 0)).toBe(
      true,
    );
    expect(textRegionTouchesSweep(rounded, { startX: 0, startY: 0, endX: 0, endY: 0 }, 0)).toBe(
      false,
    );
    expect(
      textRegionTouchesSweep(rounded, { startX: -10, startY: -10, endX: -10, endY: -10 }, 0),
    ).toBe(false);
  });
});
