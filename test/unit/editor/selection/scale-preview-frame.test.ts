import { describe, expect, it } from "vitest";

import type { BoxShapeElementV1 } from "../../../../src/domain/schema/public";
import { SelectionScalePreviewFramePlan } from "../../../../src/editor/selection/scale-preview-frame";

describe("selection scale preview frame", () => {
  it("keeps the centerline edge independent of overlapping paint widths", () => {
    const widePath = rectangle("wide-path", 100, 2);
    const widePaint = rectangle("wide-paint", 99, 22);
    const plan = new SelectionScalePreviewFramePlan([widePath, widePaint], 0);

    const initial = plan.resolve({ x: 0, y: 0 }, "bottom-right", { x: 1, y: 1 });
    const scaled = plan.resolve({ x: 0, y: 0 }, "bottom-right", { x: 20, y: 20 });

    expect(initial.frame.points[2]).toEqual({ x: 100, y: 100 });
    expect(scaled.frame.points[0]).toEqual({ x: 0, y: 0 });
    expect(scaled.frame.points[2]).toEqual({ x: 2000, y: 2000 });
  });
  it("keeps the dragged edge under its target independent of paint width", () => {
    const plan = new SelectionScalePreviewFramePlan(
      [rectangle("wide-path", 100, 2), rectangle("wide-paint", 99, 22)],
      0,
    );
    const factors = plan.factorsForPointer(
      { x: 100, y: 100 },
      { x: 2000, y: 2000 },
      { x: 0, y: 0 },
      false,
    );
    const resized = plan.resolve({ x: 0, y: 0 }, "bottom-right", factors);
    expect(resized.frame.points[2].x).toBeCloseTo(2100, 5);
    expect(resized.frame.points[2].y).toBeCloseTo(2100, 5);
  });
});

describe("uniform centerline scale recovery", () => {
  it.each([
    { initial: { x: 1, y: 1 }, movement: 5, minimum: 0, expected: { x: 1.5, y: 1.5 } },
    { initial: { x: 1, y: 0 }, movement: -5, minimum: 0, expected: { x: 0, y: 0 } },
    { initial: { x: 1, y: 0 }, movement: -2.5, minimum: 0, expected: { x: 0.5, y: 0 } },
    { initial: { x: 1, y: 0 }, movement: 0, minimum: 0, expected: { x: 1, y: 0 } },
    { initial: { x: 1, y: 0 }, movement: 5, minimum: 0, expected: { x: 1.5, y: 0.5 } },
    { initial: { x: 0, y: 1 }, movement: 5, minimum: 0, expected: { x: 0.5, y: 1.5 } },
    { initial: { x: 0, y: 0 }, movement: 5, minimum: 0, expected: { x: 0.5, y: 0.5 } },
    { initial: { x: 0, y: 0 }, movement: 0, minimum: 0, expected: { x: 0, y: 0 } },
    { initial: { x: 1, y: 0 }, movement: -5, minimum: 0.5, expected: { x: 0.5, y: 0 } },
    { initial: { x: 1, y: 0 }, movement: 0, minimum: 2, expected: { x: 2, y: 1 } },
    { initial: { x: 1, y: 1 }, movement: 1e-11, minimum: 0, expected: { x: 1, y: 1 } },
  ])(
    "resolves initial=$initial, movement=$movement, minimum=$minimum",
    ({ initial, movement, minimum, expected }) => {
      const plan = new SelectionScalePreviewFramePlan([rectangle("source", 10, 2)], 0);
      expect(
        plan.factorsForPointer(
          { x: 10, y: 10 },
          { x: movement, y: movement },
          { x: minimum, y: minimum },
          true,
          initial,
        ),
      ).toEqual(expected);
    },
  );

  it("keeps a zero-extent source stable when pointer movement cannot create geometry", () => {
    const plan = new SelectionScalePreviewFramePlan([rectangle("point", 0, 2)], 0);
    expect(plan.factorsForPointer({ x: 1, y: 1 }, { x: 10, y: 10 }, { x: 0, y: 0 }, true)).toEqual({
      x: 1,
      y: 1,
    });
  });

  it("preserves inactive axes and clamps an active axis at its minimum", () => {
    const plan = new SelectionScalePreviewFramePlan([rectangle("source", 10, 2)], 0);
    expect(
      plan.factorsForPointer({ x: -10, y: 0 }, { x: 20, y: 100 }, { x: 0.25, y: 0.5 }, false, {
        x: 1,
        y: 0,
      }),
    ).toEqual({ x: 0.25, y: 0 });
  });
});

function rectangle(id: string, size: number, outlineWidth: 2 | 22): BoxShapeElementV1 {
  return {
    createdAt: 1,
    height: size,
    id,
    kind: "rectangle",
    pivot: { x: size / 2, y: size / 2 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth,
    },
    width: size,
    x: 0,
    y: 0,
  };
}
