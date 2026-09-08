import { describe, expect, it } from "vitest";

import type { BoxShapeElementV1 } from "../../../../src/domain/schema/public";
import { SelectionScalePreviewFramePlan } from "../../../../src/editor/selection/scale-preview-frame";

describe("selection scale preview frame", () => {
  it("switches the tight painted edge when another element becomes extremal", () => {
    const widePath = rectangle("wide-path", 100, 2);
    const widePaint = rectangle("wide-paint", 99, 22);
    const plan = new SelectionScalePreviewFramePlan([widePath, widePaint], 0);

    const initial = plan.resolve({ x: -11, y: -11 }, "bottom-right", { x: 1, y: 1 });
    const scaled = plan.resolve({ x: -11, y: -11 }, "bottom-right", { x: 20, y: 20 });

    expect(initial.frame.points[2]).toEqual({ x: 110, y: 110 });
    expect(scaled.frame.points[0]).toEqual({ x: -11, y: -11 });
    expect(scaled.frame.points[2]).toEqual({ x: 2001, y: 2001 });
  });
  it("keeps the dragged edge under its target when the extremal element changes", () => {
    const plan = new SelectionScalePreviewFramePlan(
      [rectangle("wide-path", 100, 2), rectangle("wide-paint", 99, 22)],
      0,
    );
    const factors = plan.factorsForPointer(
      { x: 121, y: 121 },
      { x: 1990, y: 1990 },
      { x: 0, y: 0 },
      false,
    );
    const resized = plan.resolve({ x: -11, y: -11 }, "bottom-right", factors);
    expect(resized.frame.points[2].x).toBeCloseTo(2100, 5);
    expect(resized.frame.points[2].y).toBeCloseTo(2100, 5);
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
