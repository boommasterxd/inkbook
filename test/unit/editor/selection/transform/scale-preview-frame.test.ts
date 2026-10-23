import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import type { BoxShapeElementV1 } from "../../../../../src/domain/schema/public";
import { SelectionScalePreviewFramePlan } from "../../../../../src/editor/selection/transform/scale-preview-frame";
import {
  SelectionFrameSession,
  selectionFramePoint,
} from "../../../../../src/editor/selection/selection-frame";
import { SelectionScaleGesture } from "../../../../../src/editor/selection/transform/selection-scale";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { STROKE_FRAME_CASES } from "../../../../fixtures/editor/stroke-frame";
import { oppositeBoxAnchor } from "../../../../../src/editor/selection/handles";

describe("selection scale preview frame", () => {
  it.each([0, 37])(
    "reuses a stroke frame with canonical pivot/offset alignment at %s degrees",
    (rotation) => {
      const { element, frame } = strokeFrame(rotation);
      const reused = SelectionScalePreviewFramePlan.fromSingleStrokeFrame(element, frame);
      const reference = new SelectionScalePreviewFramePlan([element], rotation);
      const anchor = frame.points[0];
      for (const factors of [
        { x: 1, y: 1 },
        { x: 2, y: 0.5 },
        { x: 0, y: 0 },
      ]) {
        const actual = reused.boundsAt(anchor, factors);
        const expected = reference.boundsAt(anchor, factors);
        for (const key of ["minX", "minY", "maxX", "maxY"] as const)
          expect(actual[key]).toBeCloseTo(expected[key], 9);
      }
      expect(reused.without(new Set())).toBe(reused);
      expect(reused.without(new Set([element.id]))).toBeNull();
    },
  );

  it.each(STROKE_FRAME_CASES)(
    "preserves prepared side/uniform output at $rotation degrees, collapsed=$collapsed, extreme pivot=$extremePivot",
    ({ rotation, collapsed, extremePivot }) => {
      const { element, frame } = strokeFrame(rotation, collapsed, extremePivot);
      for (const position of ["middle-right", "bottom-right"] as const) {
        const start = selectionFramePoint(frame, position);
        const action = {
          anchor: selectionFramePoint(frame, oppositeBoxAnchor(position)),
          kind: "scale" as const,
          position,
          rotation,
        };
        const prepared = new SelectionScaleGesture(action, [element], start, frame);
        const reference = new SelectionScaleGesture(action, [element], start);
        const pointer = { x: start.x + 20, y: start.y + 10 };
        for (const uniform of [false, true]) {
          const actual = prepared.factorsAt(pointer, uniform);
          const expected = reference.factorsAt(pointer, uniform);
          expect(actual.x).toBeCloseTo(expected.x, 9);
          expect(actual.y).toBeCloseTo(expected.y, 9);
          if (!uniform && (collapsed === "x" || collapsed === "both"))
            expect(actual.x).toBe(expected.x);
          if (!uniform && (collapsed === "y" || collapsed === "both"))
            expect(actual.y).toBe(expected.y);
          expect(prepared.materialize(pointer, uniform)).toEqual(
            reference.materialize(pointer, uniform),
          );
        }
      }
    },
  );

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

function strokeFrame(
  rotation: number,
  collapsed: "none" | "x" | "y" | "both" = "none",
  extremePivot = false,
) {
  const element = {
    ...indexedStroke(0),
    offset: { x: 17.003, y: -11.007 },
    pivot: extremePivot ? { x: 99_900, y: -99_900 } : { x: 100, y: 100 },
    points: [
      20,
      30,
      0.5,
      collapsed === "x" || collapsed === "both" ? 20 : 65,
      collapsed === "y" || collapsed === "both" ? 30 : 80,
      0.8,
    ],
    rotation,
  };
  const selected = [{ element, bounds: calculateElementBounds(element) }];
  return { element, frame: new SelectionFrameSession().current(selected)! };
}

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
