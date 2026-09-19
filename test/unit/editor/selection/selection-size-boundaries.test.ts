import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/handle-session";
import { editLinearEndpoint } from "../../../../src/editor/selection/linear-transforms";
import {
  createSelectionFrameAtRotation,
  selectionFramePoint,
} from "../../../../src/editor/selection/selection-frame";
import {
  editCoordinateAxis,
  editCoordinateOrigin,
  scaleElement,
} from "../../../../src/editor/selection/transforms";
import {
  arrow,
  coordinateSystem,
  line,
  rectangle,
  straightHighlighter,
  table,
} from "../../domain/schema/fixtures";

const elements = [
  rectangle(),
  table(),
  coordinateSystem(),
  { ...line(), startConnection: null },
  { ...arrow(), startConnection: null, endConnection: null },
  straightHighlighter(),
];

describe("selection geometry size boundaries", () => {
  it.each(elements)(
    "collapses $kind without mirroring and restores it during the same drag",
    (source) => {
      const { session, anchor, startPointer } = resizeSession([source]);

      session.update({ x: anchor.x - 10, y: anchor.y - 10 });
      const collapsed = session.prepareCommit();
      expect(collapsed.status).toBe("ready");
      if (collapsed.status !== "ready") throw new Error("Expected a collapsed replacement.");
      const replacement = collapsed.replacements[0]!;
      expect(validateInkElementV1(replacement).ok).toBe(true);
      if (replacement.kind === "table") {
        expect(replacement).toMatchObject({ columnWidth: 0, headerHeight: 0, height: 0 });
      } else if (replacement.kind === "coordinate-system") {
        expect(
          replacement.axes.every(
            (axis) => axis.x === replacement.origin.x && axis.y === replacement.origin.y,
          ),
        ).toBe(true);
      } else if (replacement.kind === "rectangle") {
        expect(replacement).toMatchObject({ width: 0, height: 0 });
      } else if ("start" in replacement) {
        expect(replacement.start).toEqual(replacement.end);
      }

      session.update(startPointer);
      const restored = session.prepareCommit();
      expect(restored.status).toBe("noop");
    },
  );

  it.each([line(), arrow(), straightHighlighter()])(
    "moves a $kind endpoint down to zero length",
    (source) => {
      for (const distance of [0.001, 0]) {
        const point = { x: source.start.x + distance, y: source.start.y };
        const replacement = editLinearEndpoint(source, "end", point);
        expect(replacement).toMatchObject({ end: point });
        expect(validateInkElementV1(replacement).ok).toBe(true);
      }
    },
  );

  it("moves coordinate axes and the origin onto one another", () => {
    const source = coordinateSystem();
    for (const distance of [0.001, 0]) {
      const point = { x: source.origin.x + distance, y: source.origin.y };
      const replacement = editCoordinateAxis(source, 0, point);
      expect(replacement.axes[0]).toEqual(point);
      expect(validateInkElementV1(replacement).ok).toBe(true);
    }
    const shifted = editCoordinateOrigin(source, source.axes[0]);
    expect(shifted.origin).toEqual(source.axes[0]);
    expect(shifted.axes).toEqual(source.axes);
    expect(validateInkElementV1(shifted).ok).toBe(true);
  });
});

describe("tiny structural selection previews", () => {
  it.each([...elements.map((element) => [element]), elements])(
    "keeps tiny nonzero geometry consistent through preview and commit (%#)",
    (...selected) => {
      const { session, anchor } = resizeSession(selected);
      const collapsed = selected.map((element) => scaleElement(element, anchor, { x: 0, y: 0 }));
      const minimum = createSelectionFrameAtRotation(collapsed, 0)!;
      const preview = session.update({
        x: anchor.x + minimum.points[2].x - minimum.points[0].x + 0.1,
        y: anchor.y + minimum.points[2].y - minimum.points[0].y + 0.1,
      });
      const commit = session.prepareCommit();
      expect(commit.status).toBe("ready");
      if (commit.status !== "ready") throw new Error("Expected a tiny replacement.");
      expect(commit.replacements).toEqual(preview.exactElements);
      const committedFrame = createSelectionFrameAtRotation(commit.replacements, 0)!;
      for (const [index, point] of committedFrame.points.entries()) {
        expect(point.x).toBeCloseTo(preview.previewFrame!.points[index]!.x, 3);
        expect(point.y).toBeCloseTo(preview.previewFrame!.points[index]!.y, 3);
      }
      for (const replacement of commit.replacements) {
        expect(validateInkElementV1(replacement).ok).toBe(true);
        if (replacement.kind === "table") {
          expect(replacement.columnWidth).toBeGreaterThan(0);
          expect(replacement.columnWidth).toBeLessThan(1);
          expect(replacement.height).toBeGreaterThan(0);
          expect(replacement.height).toBeLessThan(4);
        } else if (replacement.kind === "rectangle") {
          expect(replacement.width).toBeGreaterThan(0);
          expect(replacement.width).toBeLessThan(4);
        } else if ("start" in replacement) {
          const length = Math.hypot(
            replacement.end.x - replacement.start.x,
            replacement.end.y - replacement.start.y,
          );
          expect(length).toBeGreaterThan(0);
          expect(length).toBeLessThan(8);
        } else if (replacement.kind === "coordinate-system") {
          for (const axis of replacement.axes) {
            const length = Math.hypot(axis.x - replacement.origin.x, axis.y - replacement.origin.y);
            expect(length).toBeGreaterThan(0);
            expect(length).toBeLessThan(4);
          }
        }
      }
    },
  );
});

function resizeSession(selected: readonly InkElementV1[]) {
  const frame = createSelectionFrameAtRotation(selected, 0)!;
  const anchor = selectionFramePoint(frame, "top-left");
  const startPointer = selectionFramePoint(frame, "bottom-right");
  const session = new SelectionHandleSession({
    action: { anchor, kind: "scale", position: "bottom-right", rotation: 0 },
    elements: selected,
    planner: new ElementStore(selected),
    startPointer,
  });
  return { session, anchor, startPointer };
}
