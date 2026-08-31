import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import {
  selectionOverlayContainsPoint,
  selectionOverlayGeometry,
  transformSelectionPoint,
} from "../../../../src/editor/selection/public";
import { connectedLine, rectangle } from "../../domain/store/fixtures";
import { straightHighlighter } from "../../domain/schema/fixtures";

function selected(element: InkElementV1) {
  return { bounds: calculateElementBounds(element), element };
}

describe("selection overlay geometry", () => {
  it("uses the rotated local box for a single non-linear element", () => {
    const shape = { ...rectangle(), rotation: 90 };

    expect(selectionOverlayGeometry([selected(shape)], 1)?.outline).toEqual({
      kind: "polygon",
      points: [
        { x: 252, y: 48 },
        { x: 252, y: 252 },
        { x: 148, y: 252 },
        { x: 148, y: 48 },
      ],
    });
  });

  it("uses a straight centerline and three editing handles for an unbent line", () => {
    const line = connectedLine();
    const geometry = selectionOverlayGeometry([selected(line)], 1);

    expect(geometry?.outline).toEqual({
      bend: null,
      end: { x: 400, y: 100 },
      kind: "linear",
      start: { x: 100, y: 100 },
    });
    expect(geometry?.handles).toMatchObject([
      { endpoint: "start", kind: "linear-endpoint", point: { x: 100, y: 100 } },
      { endpoint: "end", kind: "linear-endpoint", point: { x: 400, y: 100 } },
      { kind: "linear-bend", point: { x: 250, y: 100 } },
    ]);
  });

  it("uses the same centerline and handle contract for arrows", () => {
    const arrow = { ...connectedLine(), kind: "arrow" as const };
    const geometry = selectionOverlayGeometry([selected(arrow)], 1);

    expect(geometry?.outline.kind).toBe("linear");
    expect(geometry?.handles.map(({ kind }) => kind)).toEqual([
      "linear-endpoint",
      "linear-endpoint",
      "linear-bend",
    ]);
  });

  it("uses a straight highlighter centerline and three editing handles", () => {
    const highlighter = straightHighlighter();
    const geometry = selectionOverlayGeometry([selected(highlighter)], 1);

    expect(geometry?.outline).toEqual({
      bend: null,
      end: highlighter.end,
      kind: "linear",
      start: highlighter.start,
    });
    expect(geometry?.handles.map(({ kind }) => kind)).toEqual([
      "linear-endpoint",
      "linear-endpoint",
      "linear-bend",
    ]);
  });

  it("keeps a curved straight highlighter open while preserving its bend handle", () => {
    const highlighter = { ...straightHighlighter(), bend: { x: 150, y: 160 } };
    const geometry = selectionOverlayGeometry([selected(highlighter)], 1);

    expect(geometry?.outline).toEqual({
      bend: highlighter.bend,
      end: highlighter.end,
      kind: "linear",
      start: highlighter.start,
    });
    expect(geometry?.handles[2]).toMatchObject({
      kind: "linear-bend",
      point: { x: 150, y: 180 },
    });
  });
});

describe("selection overlay hit testing and transforms", () => {
  it("hits filled box overlays but never invents an interior for one line or arrow", () => {
    const shape = { ...rectangle(), rotation: 90 };
    const line = connectedLine();
    const arrow = { ...line, kind: "arrow" as const };

    expect(selectionOverlayContainsPoint([selected(shape)], shape.pivot)).toBe(true);
    expect(selectionOverlayContainsPoint([selected(line)], { x: 250, y: 120 })).toBe(false);
    expect(selectionOverlayContainsPoint([selected(arrow)], { x: 250, y: 120 })).toBe(false);
  });

  it("hits the empty interior of a multi-element bounding box", () => {
    const left = rectangle();
    const right = { ...rectangle(), id: "right", pivot: { x: 600, y: 150 }, x: 500 };

    expect(
      selectionOverlayContainsPoint([selected(left), selected(right)], { x: 400, y: 150 }),
    ).toBe(true);
  });

  it("preserves a curved centerline and transforms its outline and handles together", () => {
    const line = { ...connectedLine(), bend: { x: 250, y: 50 } };
    const geometry = selectionOverlayGeometry([selected(line)], 1, {
      delta: { x: 20, y: 30 },
      kind: "translate",
    });

    expect(geometry?.outline).toEqual({
      bend: { x: 270, y: 80 },
      end: { x: 420, y: 130 },
      kind: "linear",
      start: { x: 120, y: 130 },
    });
    expect(geometry?.handles.map(({ point }) => point)).toEqual([
      { x: 120, y: 130 },
      { x: 420, y: 130 },
      { x: 270, y: 105 },
    ]);
  });

  it("matches the preview transform order for rotated non-uniform scaling", () => {
    expect(
      transformSelectionPoint(
        { x: 148, y: 252 },
        {
          anchor: { x: 252, y: 48 },
          factors: { x: 1.5, y: 2 },
          kind: "scale",
          rotation: 90,
        },
      ),
    ).toEqual({ x: 44, y: 354 });
  });

  it.each([0.5, 1, 2])(
    "keeps the rotate-handle gap at 28 screen pixels during scale previews at zoom %s",
    (zoom) => {
      const geometry = selectionOverlayGeometry([selected(rectangle())], zoom, {
        anchor: { x: 98, y: 98 },
        factors: { x: 2, y: 0.5 },
        kind: "scale",
        rotation: 0,
      });
      const outline = geometry?.outline;
      const rotate = geometry?.handles.find(({ kind }) => kind === "rotate");
      if (outline?.kind !== "polygon" || rotate?.kind !== "rotate") {
        throw new Error("Expected a polygon with a rotate handle.");
      }
      const topLeft = outline.points[0]!;
      const topRight = outline.points[1]!;
      const topCenter = {
        x: (topLeft.x + topRight.x) / 2,
        y: (topLeft.y + topRight.y) / 2,
      };

      expect(Math.hypot(rotate.point.x - topCenter.x, rotate.point.y - topCenter.y) * zoom).toBe(
        28,
      );
    },
  );
});
