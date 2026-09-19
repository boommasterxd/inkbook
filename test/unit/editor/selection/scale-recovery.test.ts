import { describe, expect, it } from "vitest";

import {
  defaultTableHeaderHeight,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/public";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/handle-session";
import {
  createSelectionFrameAtRotation,
  selectionFramePoint,
} from "../../../../src/editor/selection/selection-frame";
import { scaleElement } from "../../../../src/editor/selection/transforms";
import { rectangle, table } from "../../domain/schema/fixtures";

const cases = [rectangle(), table()].flatMap((source) =>
  [0, 37, 90].flatMap((rotation) =>
    [
      { x: 0, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ].flatMap((collapsed) =>
      [false, true].map((uniformScale) => ({ source, rotation, collapsed, uniformScale })),
    ),
  ),
);

describe("collapsed structural resize recovery", () => {
  it.each(cases)(
    "recovers $source.kind at $rotation degrees, axes=$collapsed, uniform=$uniformScale",
    ({ source, rotation, collapsed, uniformScale }) => {
      const element = { ...scaleElement(source, source.pivot, collapsed), rotation };
      const original = structuredClone(element);
      const frame = createSelectionFrameAtRotation([element], rotation)!;
      const anchor = selectionFramePoint(frame, "top-left");
      const startPointer = selectionFramePoint(frame, "bottom-right");
      const session = new SelectionHandleSession({
        action: { anchor, kind: "scale", position: "bottom-right", rotation },
        elements: [element],
        planner: new ElementStore([element]),
        startPointer,
        uniformScale,
      });
      const still = session.update(startPointer);
      expect(still.exactElements).toEqual([]);
      expect(session.prepareCommit().status).toBe("noop");
      const local = rotatePointClockwise(startPointer, anchor, -rotation);
      const firstPointer = rotatePointClockwise(
        { x: local.x + 0.1, y: local.y + 0.1 },
        anchor,
        rotation,
      );
      session.update(firstPointer);
      const snapshot = session.createScalePreviewMaterializer()!;
      const firstReplacement = snapshot(element);
      for (const distance of [0.1, 120]) {
        const pointer = rotatePointClockwise(
          { x: local.x + distance, y: local.y + distance },
          anchor,
          rotation,
        );
        const preview = session.update(pointer);
        const commit = session.prepareCommit();
        expect(commit.status).toBe("ready");
        if (commit.status !== "ready") throw new Error("Expected a recovered resize.");
        expect(commit.replacements).toEqual(preview.exactElements);
        const replacement = commit.replacements[0]!;
        expect(validateInkElementV1(replacement).ok).toBe(true);
        if (!("width" in replacement) && replacement.kind !== "table")
          throw new Error("Expected structural geometry.");
        const width =
          replacement.kind === "table"
            ? replacement.columnWidth * replacement.columns
            : replacement.width;
        expect(width).toBeGreaterThan(0);
        expect(replacement.height).toBeGreaterThan(0);
        if (!uniformScale && distance === 0.1) {
          if (collapsed.x === 0) expect(width).toBeCloseTo(0.1, 2);
          if (collapsed.y === 0) expect(replacement.height).toBeCloseTo(0.1, 2);
        }
        if (replacement.kind === "table" && collapsed.y === 0) {
          expect(replacement.headerHeight).toBe(defaultTableHeaderHeight(replacement.height));
        }
      }
      expect(snapshot(element)).toEqual(firstReplacement);
      expect(element).toEqual(original);
    },
  );
});
