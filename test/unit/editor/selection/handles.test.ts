import { describe, expect, it } from "vitest";

import {
  calculateElementBounds,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/public";
import type { BoxAnchorV1, InkElementV1 } from "../../../../src/domain/schema/public";
import {
  findSelectionHandle,
  layoutSelectionHandles,
  oppositeBoxAnchor,
  selectionBounds,
} from "../../../../src/editor/selection/public";
import {
  createSelectionFrame,
  transformSelectionFrame,
} from "../../../../src/editor/selection/selection-frame";
import { connectedLine, rectangle } from "../../domain/store/fixtures";
import { coordinateSystem } from "../../domain/store/fixtures";
import { straightHighlighter, table } from "../../domain/schema/fixtures";

function selected(element: InkElementV1) {
  return { bounds: calculateElementBounds(element), element };
}

describe("selection handle geometry", () => {
  it("maps every box anchor to one stable opposite anchor", () => {
    const anchors: readonly BoxAnchorV1[] = [
      "top-left",
      "top-center",
      "top-right",
      "middle-right",
      "bottom-right",
      "bottom-center",
      "bottom-left",
      "middle-left",
    ];
    for (const anchor of anchors) {
      expect(oppositeBoxAnchor(oppositeBoxAnchor(anchor))).toBe(anchor);
    }
    expect(oppositeBoxAnchor("top-left")).toBe("bottom-right");
    expect(oppositeBoxAnchor("middle-left")).toBe("middle-right");
  });

  it("lays out rotated rectangle scale handles and a screen-sized rotation handle", () => {
    const shape = rectangle();
    shape.rotation = 90;
    const handles = layoutSelectionHandles([selected(shape)], {
      rotateOffsetPixels: 20,
      zoom: 2,
    });

    expect(handles.filter(({ kind }) => kind === "scale")).toHaveLength(8);
    expect(handles.find(({ kind }) => kind === "scale")).toMatchObject({
      kind: "scale",
      point: { x: 252, y: 48 },
      position: "top-left",
    });
    expect(handles.find(({ kind }) => kind === "rotate")?.point).toEqual({ x: 262, y: 150 });
  });

  it("uses aggregate bounds for multi-selection scale handles", () => {
    const first = selected(rectangle());
    const second = selected(rectangle("00000000-0000-4000-8000-000000000099", 500, 300));
    const bounds = selectionBounds([first, second]);
    const handles = layoutSelectionHandles([first, second], { zoom: 1 });

    expect(bounds).toEqual({ minX: 98, minY: 98, maxX: 702, maxY: 402 });
    expect(handles.filter(({ kind }) => kind === "scale")).toHaveLength(8);
    expect(handles.find(({ kind }) => kind === "rotate")?.point.y).toBe(70);
  });
});

describe("oriented multi-selection handle geometry", () => {
  it("lays out multi-selection handles in the retained oriented frame", () => {
    const first = selected(rectangle());
    const second = selected(rectangle("00000000-0000-4000-8000-000000000099", 500, 300));
    const frame = createSelectionFrame([first, second]);
    if (frame === null) throw new Error("Expected a selection frame.");
    const center = { x: 400, y: 250 };
    const oriented = transformSelectionFrame(frame, {
      center,
      degrees: 30,
      kind: "rotate",
    });
    const handles = layoutSelectionHandles([first, second], { frame: oriented, zoom: 1 });

    expect(handles[0]?.point).toEqual(oriented.points[0]);
    expect(handles[2]?.point).toEqual(oriented.points[1]);
    expect(handles[4]?.point).toEqual(oriented.points[2]);
    expect(handles[6]?.point).toEqual(oriented.points[3]);
  });
});

describe("linear and structural selection handle geometry", () => {
  it("exposes endpoint and bend handles for lines without generic box handles", () => {
    const line = connectedLine();
    const handles = layoutSelectionHandles([selected(line)], { zoom: 1 });

    expect(handles.map(({ kind }) => kind)).toEqual([
      "linear-endpoint",
      "linear-endpoint",
      "linear-bend",
    ]);
    expect(handles[2]?.point).toEqual({ x: 250, y: 100 });
  });

  it("exposes endpoint and bend handles for straight highlighters without box or rotate handles", () => {
    const highlighter = straightHighlighter();
    const handles = layoutSelectionHandles([selected(highlighter)], { zoom: 1 });

    expect(handles.map(({ kind }) => kind)).toEqual([
      "linear-endpoint",
      "linear-endpoint",
      "linear-bend",
    ]);
    expect(handles.some(({ kind }) => kind === "scale" || kind === "rotate")).toBe(false);
  });

  it.each(["line", "arrow"] as const)(
    "keeps the bend handle on the visible curved %s centerline",
    (kind) => {
      const element = {
        ...connectedLine(),
        bend: { x: 250, y: 20 },
        kind,
        pivot: { x: 250, y: 60 },
        rotation: 30,
      };
      const handles = layoutSelectionHandles([selected(element)], { zoom: 1 });
      const localCurvePoint = { x: 250, y: 60 };

      expect(handles[2]?.point).toEqual(
        rotatePointClockwise(localCurvePoint, element.pivot, element.rotation),
      );
    },
  );

  it("hit-tests screen-sized handles independently of zoom", () => {
    const handle = { kind: "rotate" as const, point: { x: 100, y: 100 } };

    expect(findSelectionHandle([handle], { x: 104, y: 100 }, 2, 8)).toBe(handle);
    expect(findSelectionHandle([handle], { x: 104.1, y: 100 }, 2, 8)).toBeNull();
  });

  it("adds origin and axis handles for coordinate systems", () => {
    const handles = layoutSelectionHandles([selected(coordinateSystem())], { zoom: 1 });

    expect(handles.filter(({ kind }) => kind === "coordinate-origin")).toHaveLength(1);
    expect(handles.filter(({ kind }) => kind === "coordinate-axis")).toHaveLength(3);
  });
});

describe("overlapping selection handles", () => {
  it.each([0, 37])(
    "prioritizes table separators over coincident outer scale handles at %s degrees",
    (rotation) => {
      const target = table();
      target.headerHeight = 0;
      target.columnOffsets = [0, 80];
      target.rotation = rotation;
      const handles = layoutSelectionHandles([selected(target)], { zoom: 1 });
      const header = handles.find((handle) => handle.kind === "table-header");
      const column = handles.find((handle) => handle.kind === "table-column");
      if (header?.kind !== "table-header" || column?.kind !== "table-column") {
        throw new TypeError("Expected table structure handles.");
      }

      expect(findSelectionHandle(handles, header.point, 1, 1)?.kind).toBe("table-header");
      expect(findSelectionHandle(handles, column.point, 1, 1)?.kind).toBe("table-column");
    },
  );
});
