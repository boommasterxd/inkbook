import { describe, expect, it } from "vitest";

import { buildPressureOutline } from "../../../../src/domain/geometry/stroke-path";
import { buildPressureOutlineSlice } from "../../../../src/domain/geometry/stroke-path-slice";

describe("outward pressure-stroke caps", () => {
  it.each([
    ["right", 10, 0, "M0 4L10 4A4 4 0 0 0 10-4L0-4A4 4 0 0 0 0 4Z"],
    ["left", -10, 0, "M0-4L-10-4A4 4 0 0 0-10 4L0 4A4 4 0 0 0 0-4Z"],
    ["down", 0, 10, "M-4 0L-4 10A4 4 0 0 0 4 10L4 0A4 4 0 0 0-4 0Z"],
    ["up", 0, -10, "M4 0L4-10A4 4 0 0 0-4-10L-4 0A4 4 0 0 0 4 0Z"],
  ] as const)("extends both caps outside a stroke drawn %s", (_direction, x, y, expected) => {
    // The outline traverses the positive normal first. Sweep 0 joins its sides
    // through the exterior endpoint half-plane; sweep 1 cuts into the stroke.
    expect(
      buildPressureOutline(
        [
          { x: 0, y: 0, pressure: 1 },
          { x, y, pressure: 1 },
        ],
        8,
      ),
    ).toBe(expected);
  });

  it("keeps each outward cap at its endpoint pressure radius", () => {
    expect(
      buildPressureOutline(
        [
          { x: 0, y: 0, pressure: 0 },
          { x: 10, y: 0, pressure: 1 },
        ],
        8,
      ),
    ).toBe("M0 1.4L10 4A4 4 0 0 0 10-4L0-1.4A1.4 1.4 0 0 0 0 1.4Z");
  });

  it.each([
    ["start", { firstBoundary: null, lastBoundary: 0 }, "M0 4L5 4L5-4L0-4A4 4 0 0 0 0 4Z"],
    ["end", { firstBoundary: 1, lastBoundary: null }, "M15 4L20 4A4 4 0 0 0 20-4L15-4L15 4Z"],
    ["interior", { firstBoundary: 0, lastBoundary: 1 }, "M5 4Q10 4 15 4L15-4Q10-4 5-4L5 4Z"],
  ] as const)("rounds only the exterior endpoint of a live %s slice", (_label, slice, d) => {
    expect(
      buildPressureOutlineSlice(
        [
          { x: 0, y: 0, pressure: 1 },
          { x: 10, y: 0, pressure: 1 },
          { x: 20, y: 0, pressure: 1 },
        ],
        8,
        slice,
      ),
    ).toEqual({ d, paint: "fill" });
  });
});
