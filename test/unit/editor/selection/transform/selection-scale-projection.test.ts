import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../../src/editor/selection/handle-session";
import {
  createSelectionFrameAtRotation,
  selectionFramePoint,
  type OrientedSelectionFrame,
} from "../../../../../src/editor/selection/selection-frame";
import {
  arrow,
  coordinateSystem,
  rectangle,
  straightHighlighter,
  table,
  stroke,
} from "../../../domain/schema/fixtures";

const cases = [rectangle(), table(), arrow(), coordinateSystem(), straightHighlighter()].flatMap(
  (source) =>
    [15, 37].flatMap((rotation) =>
      (["middle-right", "bottom-right"] as const).map((position) => ({
        source,
        kind: source.kind,
        rotation,
        position,
      })),
    ),
);

describe("mixed rotation resize projection", () => {
  it.each(cases)(
    "commits the canonical preview for $kind at $rotation degrees through $position",
    ({ source, rotation, position }) => {
      const elements = [{ ...source, rotation }, rectangle(19)];
      const frame = createSelectionFrameAtRotation(elements, 0)!;
      const opposite = position === "middle-right" ? "middle-left" : "top-left";
      const anchor = selectionFramePoint(frame, opposite);
      const startPointer = selectionFramePoint(frame, position);
      const pointer = {
        x: startPointer.x + 113,
        y: startPointer.y + (position === "middle-right" ? 0 : 79),
      };
      const session = new SelectionHandleSession({
        action: { anchor, kind: "scale", position, rotation: 0 },
        elements,
        planner: new ElementStore(elements),
        startPointer,
      });
      const preview = session.update(pointer);
      const commit = session.prepareCommit();
      expect(commit.status).toBe("ready");
      if (commit.status !== "ready") throw new Error("Expected a projected scale commit.");
      expect(commit.replacements).toEqual(preview.exactElements);
      const committedFrame = createSelectionFrameAtRotation(commit.replacements, 0)!;
      expectSameFrame(committedFrame, preview.previewFrame!);
      const fixed = selectionFramePoint(committedFrame, opposite);
      expect(fixed.x).toBeCloseTo(anchor.x, 2);
      expect(fixed.y).toBeCloseTo(anchor.y, 2);
      if (source.kind === "rectangle" || source.kind === "table") {
        // The stored box supports local-axis scale and rotation, but no shear.
        expect(commit.replacements[0]?.rotation).toBe(rotation);
      } else if (source.kind !== "coordinate-system") {
        const dragged = selectionFramePoint(committedFrame, position);
        expect(dragged.x).toBeCloseTo(pointer.x, 2);
        expect(dragged.y).toBeCloseTo(pointer.y, 2);
      }
    },
  );
});

describe("progressive mixed rotation projection", () => {
  it.each([15, 37])(
    "keeps a long pressure stroke and rotated box stable through release at %s degrees",
    (rotation) => {
      const pressure = {
        ...stroke(),
        points: Array.from({ length: 257 }, (_, index) => [
          120 + (index % 2) * 10,
          120 + (index % 3),
          0.5,
        ]).flat(),
      };
      const elements = [pressure, { ...rectangle(), rotation }];
      const frame = createSelectionFrameAtRotation(elements, 0)!;
      const anchor = selectionFramePoint(frame, "middle-left");
      const startPointer = selectionFramePoint(frame, "middle-right");
      const session = new SelectionHandleSession({
        action: { anchor, kind: "scale", position: "middle-right", rotation: 0 },
        elements,
        planner: new ElementStore(elements),
        startPointer,
      });
      const preview = session.update({ x: startPointer.x + 113, y: startPointer.y });
      expect(preview.exactPreviewTruncated).toBe(true);
      const materialized = elements.map(session.createScalePreviewMaterializer()!);
      const commit = session.prepareCommit();
      expect(commit.status).toBe("ready");
      if (commit.status !== "ready") throw new Error("Expected a pressure resize commit.");
      expect(materialized).toEqual(commit.replacements);
      const committedFrame = createSelectionFrameAtRotation(commit.replacements, 0)!;
      expectSameFrame(committedFrame, preview.previewFrame!);
    },
  );
});

function expectSameFrame(actual: OrientedSelectionFrame, expected: OrientedSelectionFrame): void {
  for (const [index, point] of actual.points.entries()) {
    expect(point.x).toBeCloseTo(expected.points[index]!.x, 2);
    expect(point.y).toBeCloseTo(expected.points[index]!.y, 2);
  }
}
