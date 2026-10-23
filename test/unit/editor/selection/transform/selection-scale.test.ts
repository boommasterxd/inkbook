import { describe, expect, it, vi } from "vitest";

import { rotatePointClockwise } from "../../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../../src/editor/selection/handle-session";
import {
  createSelectionFrameAtRotation,
  selectionFramePoint,
} from "../../../../../src/editor/selection/selection-frame";
import { line, rectangle, stroke } from "../../../domain/schema/fixtures";

const cases = [false, true].flatMap((multiple) =>
  [0, 37, 90].flatMap((rotation) =>
    (["pen", "highlighter"] as const).flatMap((tool) =>
      (tool === "pen" ? [false, true] : [false]).map((pressureEnabled) => ({
        multiple,
        rotation,
        tool,
        pressureEnabled,
      })),
    ),
  ),
);

describe("painted resize handle tracking", () => {
  it.each(cases)(
    "retains pointer position for $tool, pressure=$pressureEnabled, multiple=$multiple, rotation=$rotation",
    ({ multiple, rotation, tool, pressureEnabled }) => {
      const first = {
        ...stroke(1, tool),
        rotation,
        style: { ...stroke().style, width: 22 as const, pressureEnabled },
      };
      const elements: InkElementV1[] = multiple
        ? [first, { ...first, id: stroke(2).id, style: { ...first.style, width: 4 } }]
        : [first];
      const frame = createSelectionFrameAtRotation(elements, rotation)!;
      const anchor = selectionFramePoint(frame, "top-left");
      const startPointer = selectionFramePoint(frame, "bottom-right");
      const local = rotatePointClockwise(startPointer, anchor, -rotation);
      const pointer = rotatePointClockwise({ x: local.x + 113, y: local.y + 79 }, anchor, rotation);
      const session = new SelectionHandleSession({
        action: { anchor, kind: "scale", position: "bottom-right", rotation },
        elements,
        planner: new ElementStore(elements),
        startPointer,
      });
      const preview = session.update(pointer);
      expect(preview.exactElements).toHaveLength(0);
      const materialized = elements.map(session.createScalePreviewMaterializer()!);
      expectFrameTracksPointer(materialized, rotation, anchor, pointer);
      const commit = session.prepareCommit();
      expect(commit.status).toBe("ready");
      if (commit.status === "ready") {
        expectFrameTracksPointer(commit.replacements, rotation, anchor, pointer);
      }
    },
  );
});

const shapeCases = (
  ["rectangle", "ellipse", "triangle", "octagon", "parallelogram", "diamond"] as const
).flatMap((kind) =>
  [0, 15, 37, 90].flatMap((rotation) =>
    (["middle-right", "bottom-right"] as const).map((position) => ({ kind, rotation, position })),
  ),
);

describe("shape resize handle tracking", () => {
  it.each(shapeCases)(
    "keeps $kind handle $position at rotation $rotation under the pointer",
    ({ kind, rotation, position }) => {
      const source = { ...rectangle(), kind, rotation };
      const frame = createSelectionFrameAtRotation([source], rotation)!;
      const anchor = selectionFramePoint(
        frame,
        position === "middle-right" ? "middle-left" : "top-left",
      );
      const startPointer = selectionFramePoint(frame, position);
      const local = rotatePointClockwise(startPointer, anchor, -rotation);
      const pointer = rotatePointClockwise(
        { x: local.x + 113, y: local.y + (position === "middle-right" ? 0 : 79) },
        anchor,
        rotation,
      );
      const session = new SelectionHandleSession({
        action: { anchor, kind: "scale", position, rotation },
        elements: [source],
        planner: new ElementStore([source]),
        startPointer,
      });
      const preview = session.update(pointer);
      const dragged = selectionFramePoint(
        createSelectionFrameAtRotation(preview.exactElements, rotation)!,
        position,
      );
      expect(dragged.x).toBeCloseTo(pointer.x, 2);
      expect(dragged.y).toBeCloseTo(pointer.y, 2);
      const commit = session.prepareCommit();
      expect(commit.status).toBe("ready");
      if (commit.status === "ready") expect(commit.replacements).toEqual(preview.exactElements);
    },
  );
});

function expectFrameTracksPointer(
  elements: readonly InkElementV1[],
  rotation: number,
  anchor: { x: number; y: number },
  pointer: { x: number; y: number },
): void {
  const frame = createSelectionFrameAtRotation(elements, rotation)!;
  const fixed = selectionFramePoint(frame, "top-left");
  const dragged = selectionFramePoint(frame, "bottom-right");
  expect(fixed.x).toBeCloseTo(anchor.x, 2);
  expect(fixed.y).toBeCloseTo(anchor.y, 2);
  expect(dragged.x).toBeCloseTo(pointer.x, 2);
  expect(dragged.y).toBeCloseTo(pointer.y, 2);
}

describe("group resize snapping boundary", () => {
  it("scales free endpoints without acquiring external anchors or presenting snap guides", () => {
    const elements = [line(4), line(5)].map((element) => ({ ...element, startConnection: null }));
    const frame = createSelectionFrameAtRotation(elements, 0)!;
    const spatial = { query: vi.fn() };
    const targets = { get: vi.fn(() => null) };
    const canConnect = vi.fn(() => true);
    const session = new SelectionHandleSession({
      action: {
        anchor: selectionFramePoint(frame, "top-left"),
        kind: "scale",
        position: "bottom-right",
        rotation: 0,
      },
      elements,
      planner: new ElementStore(elements),
      snap: { spatial, targets, canConnect, pointerType: "mouse", zoom: 1 },
      startPointer: selectionFramePoint(frame, "bottom-right"),
    });
    const preview = session.update({ x: 351, y: 151 });
    expect(preview.snapCandidate).toBeNull();
    expect(preview.snapGuide).toBeNull();
    const commit = session.prepareCommit();
    expect(commit.status).toBe("ready");
    if (commit.status !== "ready") throw new Error("Expected a free group resize.");
    expect(commit.replacements).toEqual(preview.exactElements);
    for (const replacement of commit.replacements) {
      expect(replacement).toMatchObject({
        end: { x: 351, y: 150 },
        startConnection: null,
        endConnection: null,
      });
    }
    expect(spatial.query).not.toHaveBeenCalled();
    expect(targets.get).not.toHaveBeenCalled();
    expect(canConnect).not.toHaveBeenCalled();
  });
});
