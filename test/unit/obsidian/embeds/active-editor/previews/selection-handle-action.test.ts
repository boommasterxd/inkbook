import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../../../src/domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../../../../src/domain/schema/public";
import {
  oppositeElementHandlePoint,
  SelectionFrameSession,
  selectionFramePoint,
  type OrientedSelectionFrame,
  type SelectionHandle,
} from "../../../../../../src/editor/selection/public";
import { layoutSelectionHandles } from "../../../../../../src/editor/selection/handles";
import { selectionHandleAction } from "../../../../../../src/obsidian/embeds/active-editor/previews/selection-handle-action";
import { indexedStroke } from "../../../../../fixtures/editor/stroke";
import { rectangle } from "../../../../domain/geometry/fixtures";

describe("selection handle actions", () => {
  it.each(
    [0, 37].flatMap((rotation) => [false, true].map((degenerate) => ({ rotation, degenerate }))),
  )("preserves singleton stroke anchors at $rotation degrees, degenerate=$degenerate", (input) => {
    const element = {
      ...indexedStroke(0),
      offset: { x: 17, y: -11 },
      pivot: { x: -23, y: 71 },
      points: input.degenerate ? [20, 30, 0.5] : [20, 30, 0.5, 65, 80, 0.8],
      rotation: input.rotation,
    };
    const selected = geometry([element]);
    const frame = new SelectionFrameSession().current(selected)!;
    const handles = layoutSelectionHandles(selected, { frame, zoom: 1 });

    for (const handle of handles) {
      const prepared = selectionHandleAction(handle, selected, frame);
      const fallback = selectionHandleAction(handle, selected, null);
      expect(prepared.kind).toBe(fallback.kind);
      if (prepared.kind === "scale" && fallback.kind === "scale") {
        expectPoint(prepared.anchor, fallback.anchor);
        expect(prepared.position).toBe(fallback.position);
        expect(prepared.rotation).toBe(element.rotation);
      } else if (prepared.kind === "rotate" && fallback.kind === "rotate") {
        expectPoint(prepared.opposite, fallback.opposite);
        expect(prepared.center).toBe(element.pivot);
        expect(prepared.referenceRotation).toBe(element.rotation);
      } else {
        throw new Error("Expected a scale or rotation handle.");
      }
    }
  });

  it("retains element geometry for non-stroke handles even when a frame is supplied", () => {
    const element = rectangle({ pivot: { x: -20, y: 90 }, rotation: 37 });
    const selected = geometry([element]);
    const scale = selectionHandleAction(scaleHandle(), selected, unrelatedFrame());
    const rotate = selectionHandleAction(rotateHandle(), selected, unrelatedFrame());
    expect(scale).toEqual({
      anchor: oppositeElementHandlePoint(element, "bottom-right"),
      kind: "scale",
      position: "bottom-right",
      rotation: element.rotation,
    });
    expect(rotate).toEqual({
      center: element.pivot,
      kind: "rotate",
      opposite: oppositeElementHandlePoint(element, "top-center"),
      referenceRotation: element.rotation,
    });
  });

  it("retains the supplied multi-selection frame and the null-frame bounds fallback", () => {
    const selected = geometry([rectangle(), rectangle({ id: "second", x: 100 })]);
    const frame = unrelatedFrame();
    expect(selectionHandleAction(scaleHandle(), selected, frame)).toEqual({
      anchor: selectionFramePoint(frame, "top-left"),
      kind: "scale",
      position: "bottom-right",
      rotation: frame.rotation,
    });
    expect(selectionHandleAction(rotateHandle(), selected, frame)).toEqual({
      center: { x: 510, y: 610 },
      kind: "rotate",
      opposite: selectionFramePoint(frame, "bottom-center"),
      referenceRotation: frame.rotation,
    });
    expect(selectionHandleAction(scaleHandle(), selected, null)).toMatchObject({
      anchor: { x: 0, y: 0 },
      rotation: 0,
    });
    expect(selectionHandleAction(rotateHandle(), selected, null)).toMatchObject({
      center: { x: 100, y: 25 },
      opposite: { x: 100, y: 50 },
      referenceRotation: 0,
    });
  });

  it("rejects an unavailable selection rather than accepting a supplied frame", () => {
    expect(() => selectionHandleAction(scaleHandle(), [], unrelatedFrame())).toThrow(
      "Selection bounds are unavailable.",
    );
  });
});

function geometry(elements: readonly InkElementV1[]) {
  return elements.map((element) => ({ element, bounds: calculateElementBounds(element) }));
}

function scaleHandle(): Extract<SelectionHandle, { kind: "scale" }> {
  return { kind: "scale", point: { x: 0, y: 0 }, position: "bottom-right" };
}

function rotateHandle(): Extract<SelectionHandle, { kind: "rotate" }> {
  return { kind: "rotate", point: { x: 0, y: 0 } };
}

function unrelatedFrame(): OrientedSelectionFrame {
  return {
    points: [
      { x: 500, y: 600 },
      { x: 520, y: 600 },
      { x: 520, y: 620 },
      { x: 500, y: 620 },
    ],
    rotation: 90,
  };
}

function expectPoint(actual: PointV1, expected: PointV1): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
}
