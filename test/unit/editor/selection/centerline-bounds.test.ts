import { describe, expect, it } from "vitest";
import {
  calculateElementBounds,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/public";
import { selectionCenterlineBounds } from "../../../../src/editor/selection/centerline-bounds";
import {
  layoutSelectionHandles,
  findSelectionHandle,
  selectionBounds,
} from "../../../../src/editor/selection/handles";
import { selectionOverlayGeometry } from "../../../../src/editor/selection/overlay-geometry";
import { createSelectionFrameAtRotation } from "../../../../src/editor/selection/selection-frame";
import {
  stroke,
  rectangle,
  table,
  arrow,
  coordinateSystem,
  straightHighlighter,
} from "../../domain/schema/fixtures";

describe("centerline selection bounds", () => {
  it.each([
    stroke(),
    stroke(2, "highlighter"),
    straightHighlighter(),
    rectangle(),
    table(),
    arrow(),
    coordinateSystem(),
  ])("removes only the paint margin for $kind while retaining visible bounds", (element) => {
    const painted = calculateElementBounds(element);
    const original = { ...painted };
    const radius =
      element.kind === "stroke" || element.kind === "straight-highlighter"
        ? element.style.width *
          (element.kind === "straight-highlighter" || element.tool === "highlighter" ? 1.25 : 0.5)
        : element.style.outlineWidth / 2;
    const bounds = selectionCenterlineBounds(element, painted);
    expect(bounds).toEqual({
      minX: painted.minX + radius,
      minY: painted.minY + radius,
      maxX: painted.maxX - radius,
      maxY: painted.maxY - radius,
    });
    expect(painted).toEqual(original);
  });

  it.each(["pen", "highlighter"] as const)(
    "preserves zero extents and pressure samples for %s",
    (tool) => {
      const element = { ...stroke(1, tool), points: [100, 100, 0.01] };
      expect(selectionCenterlineBounds(element)).toEqual({
        minX: 100,
        maxX: 100,
        minY: 100,
        maxY: 100,
      });
      for (const points of [
        [100, 100, 0.1, 120, 100, 1],
        [100, 100, 0.1, 100, 120, 1],
      ]) {
        const bounds = selectionCenterlineBounds({ ...element, points });
        expect(bounds.maxX - bounds.minX).toBe(points[3]! - points[0]!);
        expect(bounds.maxY - bounds.minY).toBe(points[4]! - points[1]!);
      }
    },
  );

  it("uses cached group bounds without reading freehand samples", () => {
    const element = stroke();
    const bounds = calculateElementBounds(element);
    Object.defineProperty(element, "points", {
      get() {
        throw new Error("Unexpected sample read");
      },
    });
    expect(selectionBounds([{ element, bounds }])).toEqual({
      minX: 100,
      minY: 100,
      maxX: 120,
      maxY: 120,
    });
  });

  it.each([0, 37, 90])(
    "keeps a zero-width frame rotation handle reachable at %s degrees",
    (rotation) => {
      const element = { ...stroke(), rotation, points: [100, 100, 0.5, 100, 120, 0.5] };
      const selected = [{ element, bounds: calculateElementBounds(element) }];
      const top = rotatePointClockwise({ x: 100, y: 100 }, element.pivot, rotation);
      const bottom = rotatePointClockwise({ x: 100, y: 120 }, element.pivot, rotation);
      const frame = { points: [top, top, bottom, bottom] as const, rotation };
      const handles = layoutSelectionHandles(selected, { frame, zoom: 2 });
      const rotate = handles.find(({ kind }) => kind === "rotate")!;
      expect(Math.hypot(rotate.point.x - top.x, rotate.point.y - top.y)).toBeCloseTo(14);
      expect(findSelectionHandle(handles, rotate.point, 2, 5)?.kind).toBe("rotate");
      const transformed = selectionOverlayGeometry(
        selected,
        2,
        {
          kind: "scale",
          anchor: top,
          delta: { x: 0, y: 0 },
          factors: { x: 0, y: 2 },
          rotation,
        },
        frame,
      )!;
      const transformedRotate = transformed.handles.find(({ kind }) => kind === "rotate")!;
      expect(
        Math.hypot(transformedRotate.point.x - top.x, transformedRotate.point.y - top.y),
      ).toBeCloseTo(14, 3);
      expect(createSelectionFrameAtRotation([element], rotation)).not.toBeNull();
    },
  );
});
