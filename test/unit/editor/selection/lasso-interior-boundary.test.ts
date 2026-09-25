import { primitiveTouchesArea } from "../../../fixtures/editor/selection-query";
import { describe, expect, it } from "vitest";
import { createLassoSelectionArea } from "../../../../src/editor/selection/selection-area";
import {
  primitiveEnclosedByAreaSteps,
  type VisibleSelectionPrimitive,
} from "../../../../src/editor/selection/selection-area-primitives";

const inner = {
  kind: "polygon" as const,
  points: [
    { x: 20, y: 20 },
    { x: 80, y: 20 },
    { x: 80, y: 80 },
    { x: 20, y: 80 },
  ],
};
const outline = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
  { x: 0, y: 0 },
];

function enclosed(points: typeof outline, primitive: VisibleSelectionPrimitive = inner): boolean {
  const steps = primitiveEnclosedByAreaSteps(createLassoSelectionArea(points), primitive);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

describe("even-odd lasso holes inside filled pressure strips", () => {
  it("rejects an excluded loop wholly inside the painted primitive", () => {
    expect(
      enclosed([
        ...outline,
        { x: 40, y: 40 },
        { x: 60, y: 40 },
        { x: 60, y: 60 },
        { x: 40, y: 60 },
        { x: 40, y: 40 },
        { x: 0, y: 0 },
      ]),
    ).toBe(false);
  });

  it("ignores retraced connectors for constant-width pen and highlighter enclosure", () => {
    const area = [
      ...outline,
      { x: 40, y: 40 },
      { x: 40, y: 60 },
      { x: 60, y: 60 },
      { x: 60, y: 40 },
      { x: 40, y: 40 },
      { x: 0, y: 0 },
    ];
    expect(
      enclosed(area, {
        kind: "capsule",
        start: { x: 10, y: 20 },
        end: { x: 20, y: 10 },
        radius: 1,
      }),
    ).toBe(true);
    expect(
      enclosed(area, {
        kind: "capsule",
        start: { x: 30, y: 45 },
        end: { x: 35, y: 45 },
        radius: 6,
      }),
    ).toBe(false);
  });

  it("does not mistake an exterior retraced spike for an enclosed filled region", () => {
    const area = [...outline, { x: 200, y: 50 }, { x: 0, y: 0 }];
    expect(
      enclosed(area, {
        kind: "capsule",
        start: { x: 150, y: 37.5 },
        end: { x: 160, y: 40 },
        radius: 1,
      }),
    ).toBe(false);
  });

  it("does not turn retraced interior connectors into excluded regions", () => {
    expect(enclosed([...outline, { x: 50, y: 50 }, { x: 0, y: 0 }])).toBe(true);
    expect(enclosed([...outline, { x: 50, y: 50 }, { x: 25, y: 25 }, { x: 0, y: 0 }])).toBe(true);
  });
});

describe("self-crossing lasso overlap representatives", () => {
  const bow = [
    { x: 0, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
    { x: 20, y: 0 },
  ];
  it.each([0, 1, 2, 3])(
    "preserves lobes, excluded regions, and edge-only crossings from vertex %s",
    (offset) => {
      const area = createLassoSelectionArea([...bow.slice(offset), ...bow.slice(0, offset)]);
      const square = (x: number, y: number, width = 1) => ({
        kind: "polygon" as const,
        points: [
          { x, y },
          { x: x + width, y },
          { x: x + width, y: y + 1 },
          { x, y: y + 1 },
        ],
      });
      expect(primitiveTouchesArea(area, square(9, 2))).toBe(true);
      expect(primitiveTouchesArea(area, square(1, 9))).toBe(false);
      expect(primitiveTouchesArea(area, square(-1, 9, 22))).toBe(true);
    },
  );
});
