import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import {
  createSelectionFrameAtRotation,
  type SelectedElementGeometry,
  type SelectionHandlePreview,
} from "../../../../../src/editor/selection/public";
import {
  type HandleInteractionRenderer,
  SelectionHandlePresentation,
} from "../../../../../src/obsidian/embeds/active-editor/handle-presentation";
import { selectionOverlayPaths } from "../../../../../src/obsidian/embeds/active-editor/selection-overlay-path";
import { rectangle } from "../../../domain/store/fixtures";

describe("selection handle presentation", () => {
  it("keeps a resized multi-selection frame tight around exact element bounds", () => {
    const first = rectangle("first", 100, 100);
    const second = rectangle("second", 500, 100);
    const resized = [
      { ...first, pivot: { x: 300, y: 150 }, width: 400 },
      { ...second, pivot: { x: 1_102, y: 150 }, width: 400, x: 902 },
    ];
    const selected = [first, second].map(selectedGeometry);
    const initialFrame = createSelectionFrameAtRotation([first, second], 0);
    const exactFrame = createSelectionFrameAtRotation(resized, 0);
    if (initialFrame === null || exactFrame === null) throw new TypeError("Expected frames.");
    const setSelectionOverlayPath = vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>();
    const renderer = rendererPort(setSelectionOverlayPath);
    const presentation = new SelectionHandlePresentation(
      renderer,
      (point) => point,
      () => 1,
    );
    const preview: SelectionHandlePreview = {
      exactElements: resized,
      exactPreviewTruncated: false,
      snapCandidate: null,
      snapGuide: null,
      transform: {
        anchor: initialFrame.points[0],
        delta: { x: 0, y: 0 },
        factors: { x: 2, y: 1 },
        kind: "scale",
        rotation: 0,
      },
    };

    presentation.renderPreview(
      { frame: initialFrame, selected, selectedIds: new Set([first.id, second.id]) },
      preview,
      { elements: [], selectedPreviewIds: new Set() },
      [],
    );

    const expected = selectionOverlayPaths(resized.map(selectedGeometry), {
      frame: exactFrame,
      pageToScreen: (point) => point,
      zoom: 1,
    }).outline;
    const algebraic = selectionOverlayPaths(selected, {
      frame: initialFrame,
      pageToScreen: (point) => point,
      transform: preview.transform,
      zoom: 1,
    }).outline;
    expect(expected).not.toBe(algebraic);
    expect(setSelectionOverlayPath).toHaveBeenLastCalledWith(
      expected,
      "accent",
      expect.any(String),
    );
  });
});

function selectedGeometry(element: ReturnType<typeof rectangle>): SelectedElementGeometry {
  return { bounds: calculateElementBounds(element), element };
}

function rendererPort(
  setSelectionOverlayPath: HandleInteractionRenderer["setSelectionOverlayPath"],
): HandleInteractionRenderer {
  return {
    clearElementPreviews: vi.fn(),
    clearPreviewTransforms: vi.fn(),
    setElementPreviews: vi.fn(),
    setPreviewTransform: vi.fn(),
    setSelectionOverlayPath,
    setSnapMarkerPath: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
  };
}
