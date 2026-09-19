import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import {
  createSelectionFrameAtRotation,
  selectionFramePoint,
  SelectionHandleSession,
  type SelectedElementGeometry,
  type SelectionHandlePreview,
} from "../../../../../src/editor/selection/public";
import {
  type HandleInteractionRenderer,
  SelectionHandlePresentation,
} from "../../../../../src/obsidian/embeds/active-editor/handle-presentation";
import { selectionOverlayPaths } from "../../../../../src/obsidian/embeds/active-editor/selection-overlay-path";
import { ElementStore } from "../../../../../src/domain/store/public";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { stroke } from "../../../domain/schema/fixtures";
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
      previewFrame: exactFrame,
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

function selectedGeometry(element: InkElementV1): SelectedElementGeometry {
  return { bounds: calculateElementBounds(element), element };
}

function rendererPort(
  setSelectionOverlayPath: HandleInteractionRenderer["setSelectionOverlayPath"],
): HandleInteractionRenderer {
  return {
    clearElementPreviews: vi.fn(),
    clearPreviewTransforms: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
    setElementPreviews: vi.fn(),
    setPreviewTransform: vi.fn(),
    setSelectionOverlayPath,
    setSnapMarkerPath: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
  };
}

it.each([
  { rotation: 0, pressureEnabled: true, tool: "pen" as const },
  { rotation: 35, pressureEnabled: true, tool: "pen" as const },
  { rotation: 0, pressureEnabled: false, tool: "pen" as const },
  { rotation: 35, pressureEnabled: false, tool: "highlighter" as const },
])(
  "updates held $tool resize bounds at rotation $rotation with pressure=$pressureEnabled",
  ({ rotation, pressureEnabled, tool }) => {
    const base = stroke(1, tool);
    const source = { ...base, rotation, style: { ...base.style, pressureEnabled } };
    const frame = createSelectionFrameAtRotation([source], rotation)!;
    const startPointer = selectionFramePoint(frame, "bottom-right");
    const anchor = selectionFramePoint(frame, "top-left");
    const session = new SelectionHandleSession({
      action: { anchor, kind: "scale", position: "bottom-right", rotation },
      elements: [source],
      planner: new ElementStore([source]),
      startPointer,
    });
    const selected = [selectedGeometry(source)];
    const overlay = vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>();
    const presentation = new SelectionHandlePresentation(
      rendererPort(overlay),
      (point) => point,
      () => 1,
    );
    presentation.renderGeometry(selected, null, null, frame);
    const initial = overlay.mock.lastCall!;
    for (const movement of [20, 80, 5]) {
      session.update({ x: startPointer.x + movement, y: startPointer.y + movement });
      expect(session.preview.exactElements).toEqual([]);
      const previewFrame = session.preview.previewFrame!;
      const fixed = selectionFramePoint(previewFrame, "top-left");
      expect(fixed.x).toBeCloseTo(anchor.x, 2);
      expect(fixed.y).toBeCloseTo(anchor.y, 2);
      presentation.renderPreview(
        { frame, selected, selectedIds: new Set([source.id]) },
        session.preview,
        { elements: [], selectedPreviewIds: new Set() },
        [],
      );
      const intermediate = overlay.mock.lastCall!;
      expect(intermediate[0]).not.toBe(initial[0]);
      expect(intermediate[2]).not.toBe(initial[2]);
      const materialized = session.createScalePreviewMaterializer()!(source);
      const expected = selectionOverlayPaths([selectedGeometry(materialized)], {
        pageToScreen: (point) => point,
        zoom: 1,
      });
      expectPathCoordinates(intermediate[0], expected.outline);
      expectPathCoordinates(intermediate[2], expected.handles);
    }
    const prepared = session.prepareCommit();
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Expected a resize commit.");
    const committedPaths = selectionOverlayPaths(prepared.replacements.map(selectedGeometry), {
      pageToScreen: (point) => point,
      zoom: 1,
    });
    expectPathCoordinates(overlay.mock.lastCall![0], committedPaths.outline);
    expectPathCoordinates(overlay.mock.lastCall![2], committedPaths.handles);
    session.cancel();
    presentation.renderGeometry(selected, null, null, frame);
    expect(overlay.mock.lastCall).toEqual(initial);
  },
);

function expectPathCoordinates(actual: string | null | undefined, expected: string | null): void {
  const numbers = (path: string | null | undefined) =>
    (path ?? "").match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gu)!.map(Number);
  const actualValues = numbers(actual);
  const expectedValues = numbers(expected);
  expect(actualValues).toHaveLength(expectedValues.length);
  for (const [index, value] of actualValues.entries())
    expect(value).toBeCloseTo(expectedValues[index]!, 2);
}
