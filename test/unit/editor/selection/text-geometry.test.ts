import { describe, expect, it } from "vitest";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import { semanticAnchors } from "../../../../src/domain/geometry/anchors";
import { scaleMathPathDataSteps } from "../../../../src/domain/geometry/text-math-path";
import { textContentWidth } from "../../../../src/domain/geometry/text-padding";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { ElementStore } from "../../../../src/domain/store/public";
import { createSweptCapsuleCheck } from "../../../../src/editor/gestures/eraser-intersection";
import { selectionCenterlineBounds } from "../../../../src/editor/selection/centerline-bounds";
import { elementContainsPoint } from "../../../../src/editor/selection/query/hit-test";
import { visitVisibleElementPrimitives } from "../../../../src/editor/selection/query/element-selection-geometry";
import {
  moveSelection,
  rotateSelection,
  scaleElement,
} from "../../../../src/editor/selection/transform/transforms";
import { SelectionScaleGesture } from "../../../../src/editor/selection/transform/selection-scale";
import { layoutSelectionHandles } from "../../../../src/editor/selection/handles";
import { line, snapshot, textElement } from "../../domain/schema/fixtures";

describe("text field geometry", () => {
  it("hits the complete rotated transparent rectangle and visits one selection polygon", () => {
    const text = { ...textElement(), rotation: 90 };
    expect(calculateElementBounds(text)).toEqual({ minX: 125, minY: 75, maxX: 175, maxY: 175 });
    expect(selectionCenterlineBounds(text)).toEqual(calculateElementBounds(text));
    expect(elementContainsPoint(text, { x: 150, y: 160 }, 0)).toBe(true);
    expect(elementContainsPoint(text, { x: 110, y: 125 }, 0)).toBe(false);
    const primitives: unknown[] = [];
    visitVisibleElementPrimitives(text, (primitive) => {
      primitives.push(primitive);
      return true;
    });
    expect(primitives).toHaveLength(1);
    expect(primitives[0]).toMatchObject({ kind: "polygon" });
    const eraser = createSweptCapsuleCheck({ x: 150, y: 160 }, { x: 151, y: 160 }, 0, text);
    expect(eraser.advance(Infinity).result).toBe(true);
  });

  it("reuses text layout during translation and rotation and resolves all rectangle anchors", () => {
    const text = textElement();
    const moved = moveSelection([text], { x: 10, y: 20 })[0]!;
    const rotated = rotateSelection([text], text.pivot, 45)[0]!;
    expect(moved).toMatchObject({ x: 110, y: 120, style: text.style, layout: text.layout });
    expect(rotated).toMatchObject({ rotation: 45, style: text.style, layout: text.layout });
    expect(semanticAnchors(text)).toHaveLength(8);
  });

  it("propagates connected endpoints and emits text snapshots as version 2", () => {
    const text = textElement();
    const connection = {
      ...line(),
      start: { x: 200, y: 125 },
      startConnection: {
        targetId: text.id,
        anchor: { kind: "box", position: "middle-right" } as const,
      },
    };
    const store = new ElementStore([text, connection]);
    store.replaceMany(moveSelection([text], { x: 10, y: 20 }));
    expect(store.get(connection.id)!.element).toMatchObject({ start: { x: 210, y: 145 } });
    expect(store.materializeSnapshot({ page: snapshot().page, revision: 1 }).version).toBe(2);
  });

  it("scales typography, source overrides and normalized math uniformly at corners", () => {
    const text = textElement();
    text.ranges = [{ start: 0, end: 5, style: { fontSize: 8.5 } }];
    text.layout.math = [
      {
        start: 0,
        end: 5,
        display: false,
        x: 4,
        y: 5,
        width: 10,
        height: 20,
        paths: [{ d: "M 0 0 L 10 20 Q 2 3 4 5 Z" }],
      },
    ];
    const scaled = scaleElement(text, { x: 100, y: 100 }, { x: 2, y: 2 });
    expect(scaled).toMatchObject({
      width: 200,
      height: 100,
      style: { fontSize: 33 },
      ranges: [{ style: { fontSize: 17 } }],
      layout: {
        lines: [{ width: 80, height: 40, baseline: 30 }],
        math: [{ x: 8, y: 10, paths: [{ d: "M 0 0 L 20 40 Q 4 6 8 10 Z" }] }],
      },
    });
    const gesture = new SelectionScaleGesture(
      { kind: "scale", anchor: { x: 100, y: 100 }, position: "bottom-right", rotation: 0 },
      [text],
      { x: 200, y: 150 },
    );
    const factors = gesture.factorsAt({ x: 300, y: 150 }, false);
    expect(factors.x).toBe(factors.y);
    expect(finishGeometrySteps(scaleMathPathDataSteps("M 1e-3 2 H 5 V 7 C 0 1 2 3 4 5", 2))).toBe(
      "M 0.002 4 H 10 V 14 C 0 2 4 6 8 10",
    );
    expect(() => finishGeometrySteps(scaleMathPathDataSteps("M0 0 A10 10 0 0 0 20 20", 2))).toThrow(
      RangeError,
    );
  });

  it("offers width reflow handles and preserves font size for horizontal field resize", () => {
    const text = textElement();
    const handles = layoutSelectionHandles(
      [{ element: text, bounds: calculateElementBounds(text) }],
      { zoom: 1 },
    );
    expect(handles.filter((handle) => handle.kind === "scale")).toHaveLength(6);
    const resized = scaleElement(text, { x: 100, y: 100 }, { x: 2, y: 1 });
    expect(resized).toMatchObject({
      width: 200,
      height: 50,
      style: { fontSize: 16.5 },
      layout: text.layout,
    });
  });
});

it("keeps fractional corner padding inside the final rounded width during native reflow", async () => {
  const original = textElement();
  const text = {
    ...original,
    style: { ...original.style, fontSize: 24 },
    layout: { ...original.layout, padding: 25 },
  };
  const anchor = { x: text.x, y: text.y };
  const start = { x: text.x + text.width, y: text.y + text.height };
  const gesture = new SelectionScaleGesture(
    { kind: "scale", anchor, position: "bottom-right", rotation: 0 },
    [text],
    start,
  );
  const factors = { x: 0.50003, y: 0.50003 };
  const scaled = await gesture.materializeOneTimeSliced(
    text,
    start,
    true,
    factors,
    { shouldYield: () => false, yieldControl: async () => undefined },
    "reflow",
  );
  if (scaled?.kind !== "text") throw new Error("Expected the scaled text field.");
  expect(scaled.width).toBe(50.003);
  expect(scaled.layout.padding).toBe(12.5);
  expect(textContentWidth(scaled.width, scaled.layout.padding)).toBe(25.003);
  expect(scaleElement(text, anchor, factors)).toMatchObject({
    width: scaled.width,
    layout: { padding: scaled.layout.padding },
  });
  const roundedFont = await gesture.materializeOneTimeSliced(
    text,
    start,
    true,
    { x: 0.99999, y: 0.99999 },
    { shouldYield: () => false, yieldControl: async () => undefined },
  );
  if (roundedFont?.kind !== "text") throw new Error("Expected the scaled text field.");
  expect(roundedFont.style.fontSize).toBe(text.style.fontSize);
  expect(roundedFont.width).toBe(99.999);
  expect(textContentWidth(roundedFont.width, roundedFont.layout.padding)).toBe(50.001);
});
