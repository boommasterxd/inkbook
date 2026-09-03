import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { selectionScalePreview } from "../../../../../src/obsidian/embeds/active-editor/selection-scale-preview";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { arrow, coordinateSystem, rectangle } from "../../../domain/schema/fixtures";

const SCALE_PREVIEW_BASE = {
  snapCandidate: null,
  snapGuide: null,
  transform: {
    anchor: { x: 0, y: 0 },
    delta: { x: 0, y: 0 },
    factors: { x: 2, y: 2 },
    kind: "scale" as const,
    rotation: 0,
  },
};

describe("selection scale preview", () => {
  it("uses exact scaled pressure and fixed-node geometry without a second SVG transform", () => {
    const stroke = indexedStroke(1);
    const axes = coordinateSystem();
    if (axes.dimension !== "2d") throw new TypeError("Expected 2D coordinate-system fixture.");
    const directed = arrow();
    const box = rectangle();
    const exactStroke: typeof stroke = {
      ...stroke,
      points: stroke.points.map((value, index) => (index % 3 === 2 ? value : value * 2)),
    };
    const exactAxes: typeof axes = {
      ...axes,
      axes: axes.axes.map(({ x, y }) => ({ x: x * 2, y: y * 2 })) as [
        { x: number; y: number },
        { x: number; y: number },
      ],
    };
    const exactDirected: typeof directed = {
      ...directed,
      end: { x: directed.end.x * 2, y: directed.end.y * 2 },
    };
    const exactBox: typeof box = { ...box, width: box.width * 2 };
    const exact: InkElementV1[] = [exactStroke, exactAxes, exactDirected, exactBox];
    const selected = [stroke, axes, directed, box].map((element) => ({
      bounds: calculateElementBounds(element),
      element,
    }));

    const result = selectionScalePreview(selected, {
      ...SCALE_PREVIEW_BASE,
      exactElements: exact,
      exactPreviewTruncated: false,
    });

    expect(result.elements).toEqual(exact.slice(0, 3));
    expect(result.exactPreviewIds).toEqual(new Set([stroke.id, axes.id, directed.id]));
  });

  it("uses a non-scaling centerline fallback for a truncated pressure stroke", () => {
    const stroke = indexedStroke(1);
    const result = selectionScalePreview(
      [{ bounds: calculateElementBounds(stroke), element: stroke }],
      {
        ...SCALE_PREVIEW_BASE,
        exactElements: [],
        exactPreviewTruncated: true,
      },
    );

    expect(result.exactPreviewIds.size).toBe(0);
    expect(result.elements).toEqual([
      { ...stroke, style: { ...stroke.style, pressureEnabled: false } },
    ]);
  });
});
