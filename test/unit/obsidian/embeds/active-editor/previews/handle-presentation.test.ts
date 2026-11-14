import { describe, expect, it, vi } from "vitest";
import { scaledHandlePointer } from "../../../../../fixtures/editor/text-handle-session";

import {
  calculateElementBounds,
  normalizeRotation,
  rotatePointClockwise,
} from "../../../../../../src/domain/geometry/public";
import {
  createSelectionFrameAtRotation,
  selectionFramePoint,
  selectionOverlayGeometry,
  SelectionHandleSession,
  SelectionFrameSession,
  ConnectedSelectionPreviewSession,
  type SelectedElementGeometry,
  type SelectionHandlePreview,
} from "../../../../../../src/editor/selection/public";
import {
  type HandleInteractionRenderer,
  SelectionHandlePresentation,
} from "../../../../../../src/obsidian/embeds/active-editor/previews/handle-presentation";
import { selectionOverlayPaths } from "../../../../../../src/obsidian/embeds/active-editor/previews/selection-overlay-path";
import { ElementStore } from "../../../../../../src/domain/store/public";
import type { InkElementV1 } from "../../../../../../src/domain/schema/public";
import { stroke } from "../../../../domain/schema/fixtures";
import { connectedLine, rectangle } from "../../../../domain/store/fixtures";
import { connectionChain } from "../../../../../fixtures/domain/connection-chain";
import { rotateSelection } from "../../../../../../src/editor/selection/transform/transforms";
import { textElement } from "../../../../../fixtures/rendering/text";
import { TextEditingFrame } from "../../../../../../src/obsidian/embeds/active-editor/previews/text-editing-frame";
import { selectionHandleAction } from "../../../../../../src/obsidian/embeds/active-editor/previews/selection-handle-action";

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
    const editing = new TextEditingFrame();
    const presentation = new SelectionHandlePresentation(
      renderer,
      (point) => point,
      () => 1,
      (geometry) => editing.preview(geometry),
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

it.each([0, 37])(
  "keeps connected shape rotation coherent through reversal, cancel and commit from %s degrees",
  (rotation) => {
    const target = rectangle();
    const base = [target, connectedLine(target)];
    const center = { x: 250, y: 150 };
    const frames = new SelectionFrameSession();
    const unrotated = frames.current(base.map(selectedGeometry))!;
    frames.transition(unrotated, { kind: "rotate", center, degrees: rotation })!.apply();
    const elements = rotateSelection(base, center, rotation);
    const store = new ElementStore(elements);
    const selected = elements.map(selectedGeometry);
    const selectedIds = new Set(elements.map(({ id }) => id));
    const frame = frames.current(selected)!;
    const geometry = selectionOverlayGeometry(selected, 1, null, frame)!;
    const handle = geometry.handles.find(({ kind }) => kind === "rotate")!;
    const startPointer = handle.point;
    const action = selectionHandleAction(handle, selected, frame);
    const connected = new ConnectedSelectionPreviewSession(store, elements, selectedIds);
    const overlay = vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>();
    const presentation = new SelectionHandlePresentation(
      rendererPort(overlay),
      (point) => point,
      () => 1,
    );
    const createSession = () =>
      new SelectionHandleSession({
        action,
        elements,
        planner: store,
        startPointer,
      });
    let session = createSession();
    const renderPreview = (preview: SelectionHandlePreview) =>
      presentation.renderPreview(
        { frame, selected, selectedIds },
        preview,
        { elements: [], selectedPreviewIds: connected.selectedPreviewIds },
        [],
      );
    try {
      expect(connected.selectedPreviewIds.size).toBe(1);
      presentation.renderGeometry(selected, geometry);
      const original = overlay.mock.lastCall!;
      for (const degrees of [30, -20, 5]) {
        const preview = session.update(rotatePointClockwise(startPointer, center, degrees));
        expect(preview.exactPreviewTruncated).toBe(false);
        expect(preview.exactElements).toHaveLength(2);
        renderPreview(preview);
        const [x1, y1, x2, y2] = pathCoordinates(overlay.mock.lastCall![0]);
        const angle = (Math.atan2(y2! - y1!, x2! - x1!) * 180) / Math.PI;
        expect(angle).toBeCloseTo(normalizeRotation(rotation + degrees), 3);
      }
      session.cancel();
      presentation.clearPreviews();
      presentation.renderGeometry(selected, geometry);
      expect(overlay.mock.lastCall).toEqual(original);
      expect(store.instrumentation.publishedDeltas).toBe(0);
      session = createSession();
      const preview = session.update(rotatePointClockwise(startPointer, center, 30));
      renderPreview(preview);
      const live = overlay.mock.lastCall!;
      const prepared = session.prepareCommit();
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") throw new Error("Expected a rotation commit.");
      const effect = frames.transition(frame, preview.transform)!;
      effect.apply();
      const committed = prepared.replacements.map(selectedGeometry);
      presentation.renderGeometry(
        committed,
        selectionOverlayGeometry(committed, 1, null, frames.current(committed)),
      );
      expectPathCoordinates(overlay.mock.lastCall![0], live[0]);
      expectPathCoordinates(overlay.mock.lastCall![2], live[2] ?? null);
      expect(frames.current(committed)!.rotation).toBe(normalizeRotation(rotation + 30));
    } finally {
      session.cancel();
      connected.dispose();
    }
  },
);

it("retains the live source height in side-resize feedback and follows subsequent editor reflow", () => {
  const source = textElement();
  const { editing, overlay, presentation } = editingPresentation(source);
  const resized = { ...source, width: 400, height: 80 };
  const context = {
    frame: null,
    selected: [selectedGeometry(source)],
    selectedIds: new Set([source.id]),
  };
  const preview: SelectionHandlePreview = {
    exactElements: [resized],
    exactPreviewTruncated: true,
    previewFrame: null,
    snapCandidate: null,
    snapGuide: null,
    transform: null,
  };
  const draw = () =>
    presentation.renderPreview(
      context,
      preview,
      { elements: [], selectedPreviewIds: new Set() },
      [],
    );
  draw();
  let points = pathCoordinates(overlay.mock.calls[overlay.mock.calls.length - 1]?.[0]);
  expect(Math.max(...points.filter((_, index) => index % 2 === 0))).toBe(410);
  expect(Math.max(...points.filter((_, index) => index % 2 === 1))).toBe(200);
  editing.set(source.id, 140);
  draw();
  points = pathCoordinates(overlay.mock.calls[overlay.mock.calls.length - 1]?.[0]);
  expect(Math.max(...points.filter((_, index) => index % 2 === 1))).toBe(160);
});

function editingPresentation(source: InkElementV1) {
  const editing = new TextEditingFrame();
  editing.set(source.id, 180);
  const overlay = vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>();
  const presentation = new SelectionHandlePresentation(
    rendererPort(overlay),
    (point) => point,
    () => 1,
    (selected) => editing.preview(selected),
  );
  return { editing, overlay, presentation };
}

function selectedGeometry(element: InkElementV1): SelectedElementGeometry {
  return { bounds: calculateElementBounds(element), element };
}

it.each([0, 37])("scales the measured editing extent exactly once at %s degrees", (rotation) => {
  const source = { ...textElement(), rotation };
  const frame = createSelectionFrameAtRotation([source], rotation)!;
  const anchor = selectionFramePoint(frame, "top-left");
  const start = selectionFramePoint(frame, "bottom-right");
  const session = new SelectionHandleSession({
    action: { anchor, kind: "scale", position: "bottom-right", rotation },
    elements: [source],
    planner: new ElementStore([source]),
    startPointer: start,
  });
  const preview = session.update(scaledHandlePointer(anchor, start, 2));
  const scaled = session.createScalePreviewMaterializer()!(source);
  const { overlay, presentation } = editingPresentation(source);
  presentation.renderPreview(
    { frame, selected: [selectedGeometry(source)], selectedIds: new Set([source.id]) },
    preview,
    { elements: [], selectedPreviewIds: new Set() },
    [],
  );
  const visible = { ...scaled, height: 360 };
  const expected = selectionOverlayPaths([selectedGeometry(visible)], {
    pageToScreen: (point) => point,
    zoom: 1,
    frame: createSelectionFrameAtRotation([visible], rotation),
  });
  expectPathCoordinates(overlay.mock.lastCall![0], expected.outline);
  expectPathCoordinates(overlay.mock.lastCall![2], expected.handles);
  session.cancel();
});

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

it.each(["linear-endpoint", "linear-bend"] as const)(
  "renders local %s feedback while global connection planning is deferred",
  (kind) => {
    const elements = connectionChain(3);
    const source = elements[elements.length - 1]!;
    const store = new ElementStore(elements);
    const plan = vi.spyOn(store, "planReplacements");
    const action =
      kind === "linear-endpoint"
        ? { kind, elementId: source.id, endpoint: "end" as const }
        : { kind, elementId: source.id };
    const session = new SelectionHandleSession({
      action,
      elements: [source],
      planner: store,
      startPointer: kind === "linear-endpoint" ? source.end : source.pivot,
    });
    const preview = session.update({ x: 450, y: 180 });
    expect(preview.exactPreviewTruncated).toBe(true);
    expect(preview.exactElements).toHaveLength(1);
    expect(preview.exactElements[0]).not.toEqual(source);
    expect(session.prepareCommit().status).toBe("time-sliced-required");
    expect(plan).not.toHaveBeenCalled();
    plan.mockRestore();
    const overlay = vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>();
    const renderer = rendererPort(overlay);
    const elementsPreview = vi.spyOn(renderer, "setElementPreviews");
    const presentation = new SelectionHandlePresentation(
      renderer,
      (point) => point,
      () => 1,
    );
    presentation.renderPreview(
      { frame: null, selected: [selectedGeometry(source)], selectedIds: new Set([source.id]) },
      preview,
      { elements: [], selectedPreviewIds: new Set() },
      [],
    );
    expect(elementsPreview).toHaveBeenCalledWith(preview.exactElements, 1);
    const expected = selectionOverlayPaths(preview.exactElements.map(selectedGeometry), {
      pageToScreen: (point) => point,
      zoom: 1,
    });
    expect(overlay).toHaveBeenCalledWith(expected.outline, "none", expected.handles);
    expect(store.instrumentation.publishedDeltas).toBe(0);
  },
);

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
    presentation.renderGeometry(selected, selectionOverlayGeometry(selected, 1, null, frame));
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
    presentation.renderGeometry(selected, selectionOverlayGeometry(selected, 1, null, frame));
    expect(overlay.mock.lastCall).toEqual(initial);
  },
);

function expectPathCoordinates(actual: string | null | undefined, expected: string | null): void {
  const actualValues = pathCoordinates(actual);
  const expectedValues = pathCoordinates(expected);
  expect(actualValues).toHaveLength(expectedValues.length);
  for (const [index, value] of actualValues.entries())
    expect(value).toBeCloseTo(expectedValues[index]!, 2);
}

function pathCoordinates(path: string | null | undefined): number[] {
  return (path ?? "").match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gu)!.map(Number);
}

it("publishes a retained native text basis and residual overlay together while preserving its source frame", () => {
  const basis = textElement();
  const selected = [selectedGeometry(basis)];
  const overlay = vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>();
  const renderer = rendererPort(overlay);
  const elementPreviews = vi.spyOn(renderer, "setElementPreviews");
  const editing = new TextEditingFrame();
  editing.set(basis.id, basis.height + 100, basis);
  const presentation = new SelectionHandlePresentation(
    renderer,
    (point) => point,
    () => 1,
    (next) => editing.preview(next),
  );
  const transform = {
    kind: "scale" as const,
    anchor: { x: 0, y: 0 },
    delta: { x: 0, y: 0 },
    rotation: 0,
    factors: { x: 1.25, y: 1.25 },
  };
  const preview: SelectionHandlePreview = {
    exactElements: [basis],
    textScaleBasis: basis,
    exactPreviewTruncated: true,
    previewFrame: null,
    snapCandidate: null,
    snapGuide: null,
    transform,
  };
  presentation.renderPreview(
    { selected, selectedIds: new Set([basis.id]), frame: null },
    preview,
    { elements: [], selectedPreviewIds: new Set() },
    [],
  );
  const expected = selectionOverlayPaths(selected, {
    pageToScreen: (point) => point,
    zoom: 1,
    transform,
    frame: editing.preview(selected),
  });
  expect(overlay).toHaveBeenLastCalledWith(expected.outline, "accent", expected.handles, true);
  expect(elementPreviews).toHaveBeenLastCalledWith([basis], expect.any(Number));
});
