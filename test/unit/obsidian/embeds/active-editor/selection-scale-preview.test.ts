import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { SelectionScalePreviewPlan } from "../../../../../src/obsidian/embeds/active-editor/selection-scale-preview";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { arrow, coordinateSystem, rectangle } from "../../../domain/schema/fixtures";

const SCALE_PREVIEW_BASE = {
  previewFrame: null,
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

    const result = new SelectionScalePreviewPlan(selected).resolve({
      ...SCALE_PREVIEW_BASE,
      exactElements: exact,
      exactPreviewTruncated: false,
    });

    expect(result.elements).toEqual(exact.slice(0, 3));
  });

  it("retains local pressure data and stable fallback identities for a truncated stroke", () => {
    const stroke = indexedStroke(1);
    const plan = new SelectionScalePreviewPlan([
      { bounds: calculateElementBounds(stroke), element: stroke },
    ]);
    const preview = {
      ...SCALE_PREVIEW_BASE,
      exactElements: [],
      exactPreviewTruncated: true,
    };
    const result = plan.resolve(preview);
    const repeated = plan.resolve(preview);

    expect(result.elements).toEqual([stroke]);
    expect(result.elements[0]).toBe(stroke);
    expect(result.pressurePreviewIds).toEqual(new Set([stroke.id]));
    expect(repeated.pressurePreviewIds).toBe(result.pressurePreviewIds);
    expect(repeated.elements).toBe(result.elements);
  });
});
