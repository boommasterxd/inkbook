import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import { pressureStrokeScalePreview } from "../../../../../src/obsidian/embeds/active-editor/pressure-stroke-preview";
import { indexedStroke } from "../../../../fixtures/editor/stroke";

const SCALE_PREVIEW_BASE = {
  snapCandidate: null,
  snapGuide: null,
  transform: {
    anchor: { x: 0, y: 0 },
    factors: { x: 2, y: 2 },
    kind: "scale" as const,
    rotation: 0,
  },
};

describe("pressure stroke scale preview", () => {
  it("uses exact scaled pressure geometry without a second SVG transform", () => {
    const stroke = indexedStroke(1);
    const scaled = {
      ...stroke,
      points: stroke.points.map((value, index) => (index % 3 === 2 ? value : value * 2)),
    };
    const result = pressureStrokeScalePreview(
      [{ bounds: calculateElementBounds(stroke), element: stroke }],
      new Set([stroke.id]),
      {
        ...SCALE_PREVIEW_BASE,
        exactElements: [scaled],
        exactPreviewTruncated: false,
      },
    );

    expect(result.elements).toEqual([scaled]);
    expect(result.exactPreviewIds).toEqual(new Set([stroke.id]));
  });

  it("uses a non-scaling centerline fallback when exact pressure geometry is over budget", () => {
    const stroke = indexedStroke(1);
    const result = pressureStrokeScalePreview(
      [{ bounds: calculateElementBounds(stroke), element: stroke }],
      new Set([stroke.id]),
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
