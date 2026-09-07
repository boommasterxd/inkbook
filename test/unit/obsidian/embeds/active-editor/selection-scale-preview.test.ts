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

    expect(result.elements).toEqual(exact);
  });

  it("defers truncated scale geometry without creating an alternate pressure representation", () => {
    const stroke = indexedStroke(1);
    const plain = { ...indexedStroke(2), style: { ...stroke.style, pressureEnabled: false } };
    const axes = coordinateSystem();
    const directed = arrow();
    const box = rectangle();
    const plan = new SelectionScalePreviewPlan(
      [stroke, axes, directed, box, plain].map((element) => ({
        bounds: calculateElementBounds(element),
        element,
      })),
    );
    const preview = {
      ...SCALE_PREVIEW_BASE,
      exactElements: [],
      exactPreviewTruncated: true,
    };

    expect(plan.resolve(preview).elements).toEqual([]);
    expect(plan.progressiveIds).toEqual([stroke.id, axes.id, directed.id, box.id, plain.id]);
    const materialize = plan.materializer((element) => ({ ...element, rotation: 30 }));
    expect(materialize(stroke.id)).toEqual({ ...stroke, rotation: 30 });
    expect(materialize(box.id)).toEqual({ ...box, rotation: 30 });
    expect(materialize(plain.id)).toEqual({ ...plain, rotation: 30 });
    expect(materialize("unknown")).toBeUndefined();
  });
});
