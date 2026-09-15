import { describe, expect, it } from "vitest";

import { createLassoSelectionArea } from "../../../../src/editor/selection/selection-area";
import { primitiveEnclosedByArea } from "../../../../src/editor/selection/selection-area-primitives";

const area = createLassoSelectionArea([
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]);

describe("zero-length selection capsules", () => {
  it.each([
    { x: 5, y: 5, radius: 0, enclosed: true },
    { x: 11, y: 5, radius: 0, enclosed: false },
    { x: 0, y: 5, radius: 0, enclosed: true },
    { x: 0, y: 0, radius: 0, enclosed: true },
    { x: 5, y: 5, radius: 5, enclosed: true },
    { x: 1, y: 5, radius: 2, enclosed: false },
    { x: 0, y: 0, radius: 1, enclosed: false },
  ])("preserves enclosure at ($x, $y) with radius $radius", ({ x, y, radius, enclosed }) => {
    expect(
      primitiveEnclosedByArea(area, {
        kind: "capsule",
        start: { x, y },
        end: { x, y },
        radius,
      }),
    ).toBe(enclosed);
  });
});
