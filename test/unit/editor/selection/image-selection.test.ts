import { describe, expect, it } from "vitest";
import {
  calculateElementBounds,
  rotatePointClockwise,
  translateElementGeometry,
} from "../../../../src/domain/geometry/public";
import { copyRuntimeElementSteps } from "../../../../src/domain/elements/runtime-element-copy";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { createSweptCapsuleCheck } from "../../../../src/editor/gestures/eraser-intersection";
import { selectionCenterlineBounds } from "../../../../src/editor/selection/centerline-bounds";
import {
  elementContainsPoint,
  HitTestScratch,
} from "../../../../src/editor/selection/query/hit-test";
import { visitVisibleElementPrimitives } from "../../../../src/editor/selection/query/element-selection-geometry";
import { SelectionScaleGesture } from "../../../../src/editor/selection/transform/selection-scale";
import {
  moveSelection,
  rotateSelection,
} from "../../../../src/editor/selection/transform/transforms";
import {
  createSelectionFrameAtRotation,
  selectionFramePoint,
} from "../../../../src/editor/selection/selection-frame";
import { layoutSelectionHandles } from "../../../../src/editor/selection/handles";
import { imageElement } from "../../../fixtures/domain/images";
import { rectangle, straightHighlighter } from "../../domain/schema/fixtures";

describe("native image selection geometry", () => {
  it("uses only the visible rotated crop box for bounds, hit testing and selection primitives", () => {
    const image = { ...imageElement(), rotation: 90 };
    const bounds = calculateElementBounds(image);
    expect(bounds).toEqual({ minX: 150, minY: 150, maxX: 250, maxY: 350 });
    expect(selectionCenterlineBounds(image)).toEqual(bounds);
    expect(elementContainsPoint(image, { x: 200, y: 160 }, 0)).toBe(true);
    expect(elementContainsPoint(image, { x: 110, y: 250 }, 0)).toBe(false);
    expect(elementContainsPoint(image, { x: 145, y: 250 }, 5)).toBe(true);
    const primitives: unknown[] = [];
    expect(
      visitVisibleElementPrimitives(image, (primitive) => {
        primitives.push(primitive);
        return true;
      }),
    ).toBe(true);
    expect(primitives).toEqual([
      {
        kind: "polygon",
        points: [
          { x: 250, y: 150 },
          { x: 250, y: 350 },
          { x: 150, y: 350 },
          { x: 150, y: 150 },
        ],
      },
    ]);
  });

  it("prioritizes annotations and highlights over images regardless of visitation order", () => {
    const image = { ...imageElement(), x: 100, y: 100, pivot: { x: 200, y: 150 } };
    const highlight = {
      ...straightHighlighter(),
      start: { x: 100, y: 150 },
      end: { x: 300, y: 150 },
    };
    const shape = {
      ...rectangle(),
      style: {
        ...rectangle().style,
        fillColor: { type: "rgba" as const, value: "#000000FF" as const },
        fillOpacity: 1,
      },
    };
    const scratch = new HitTestScratch();
    for (const reversed of [false, true]) {
      const candidates = [
        { element: image, band: "image" as const, rank: 99 },
        { element: highlight, band: "highlight" as const, rank: 2 },
        { element: shape, band: "content" as const, rank: 0 },
      ];
      scratch.begin({ x: 150, y: 150 }, "mouse", 1);
      for (const item of reversed ? candidates.reverse() : candidates)
        scratch.consider(item.element.id, item.band, item.element, item.rank);
      expect(scratch.finish()).toBe(shape.id);
      scratch.begin({ x: 250, y: 150 }, "mouse", 1);
      scratch.consider(image.id, "image", image, 99);
      scratch.consider(highlight.id, "highlight", highlight, 2);
      expect(scratch.finish()).toBe(highlight.id);
    }
  });
});

describe("native image transforms and editing", () => {
  it("moves and rotates images without touching their source crop or asset reference", () => {
    const image = imageElement();
    const moved = moveSelection([image], { x: 20, y: -10 })[0]!;
    expect(moved).toMatchObject({ x: 120, y: 190, crop: image.crop, assetId: image.assetId });
    expect(translateElementGeometry(image, { x: 20, y: -10 })).toEqual(moved);
    const rotated = rotateSelection([image], { x: 0, y: 0 }, 90)[0]!;
    expect(rotated).toMatchObject({ rotation: 90, pivot: { x: -250, y: 200 }, crop: image.crop });
    const handles = layoutSelectionHandles(
      [{ element: rotated, bounds: calculateElementBounds(rotated) }],
      { zoom: 1 },
    );
    expect(handles.filter((handle) => handle.kind === "scale")).toHaveLength(8);
    expect(handles.some((handle) => handle.kind === "rotate")).toBe(true);
  });

  it.each(["bottom-right", "middle-right"] as const)(
    "keeps aspect ratio and the opposite %s handle stationary",
    (position) => {
      const image = { ...imageElement(), rotation: 37 };
      const frame = createSelectionFrameAtRotation([image], image.rotation)!;
      const anchor = selectionFramePoint(
        frame,
        position === "bottom-right" ? "top-left" : "middle-left",
      );
      const start = selectionFramePoint(frame, position);
      const pointer = rotatePointClockwise(
        { x: image.x + image.width * 2, y: image.y + image.height * 1.2 },
        image.pivot,
        image.rotation,
      );
      const gesture = new SelectionScaleGesture(
        { kind: "scale", position, rotation: image.rotation, anchor },
        [image],
        start,
      );
      const factors = gesture.factorsAt(pointer, false);
      expect(factors.x).toBe(factors.y);
      const scaled = gesture.materialize(pointer, false)[0]!;
      expect(scaled.kind).toBe("image");
      if (scaled.kind !== "image") throw new Error("Expected image geometry.");
      expect(scaled.width / scaled.height).toBeCloseTo(image.width / image.height, 4);
      const after = selectionFramePoint(
        createSelectionFrameAtRotation([scaled], image.rotation)!,
        position === "bottom-right" ? "top-left" : "middle-left",
      );
      expect(after.x).toBeCloseTo(anchor.x, 2);
      expect(after.y).toBeCloseTo(anchor.y, 2);
      expect(validateInkElementV1(scaled).ok).toBe(true);
      expect(scaled.crop).toBe(image.crop);
    },
  );

  it("copies crop metadata into owned runtime headers and never lets the eraser remove images", () => {
    const image = imageElement();
    const copy = copyRuntimeElementSteps(image).next();
    expect(copy.done).toBe(true);
    const value = copy.value;
    expect(value).toEqual(image);
    expect(value?.crop).not.toBe(image.crop);
    image.crop.x = 10;
    expect(value?.crop.x).toBe(0);
    const check = createSweptCapsuleCheck({ x: 90, y: 190 }, { x: 310, y: 310 }, 50, image);
    expect(check.advance(1)).toEqual({ result: false, workUnits: 0 });
  });
});

it("scales image groups proportionally and preserves positive image dimensions when the handle crosses its anchor", () => {
  const image = imageElement();
  const elements = [image, rectangle()];
  const frame = createSelectionFrameAtRotation(elements, 0)!;
  const anchor = selectionFramePoint(frame, "top-left");
  const start = selectionFramePoint(frame, "bottom-right");
  const gesture = new SelectionScaleGesture(
    { kind: "scale", position: "bottom-right", rotation: 0, anchor },
    elements,
    start,
  );
  const factors = gesture.factorsAt({ x: start.x + 200, y: start.y + 50 }, false);
  expect(factors.x).toBe(factors.y);
  const replacements = gesture.materialize({ x: anchor.x - 200, y: anchor.y - 200 }, false);
  const scaled = replacements[0]!;
  expect(scaled.kind).toBe("image");
  if (scaled.kind !== "image") throw new Error("Expected image geometry.");
  expect(scaled.width).toBeGreaterThan(0);
  expect(scaled.height).toBeGreaterThan(0);
  expect(validateInkElementV1(scaled).ok).toBe(true);
});
