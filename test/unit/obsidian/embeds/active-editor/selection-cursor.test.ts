import { describe, expect, it } from "vitest";
import type { SelectionHandle, SelectionOutline } from "../../../../../src/editor/selection/public";
import {
  selectionCursorContainsPoint,
  selectionCursorRadius,
  selectionHandleCursor,
} from "../../../../../src/obsidian/embeds/active-editor/selection-cursor";

const point = { x: 0, y: 0 };
const outline: SelectionOutline = {
  kind: "polygon",
  points: [point, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
};

describe("selection system cursors", () => {
  it.each([
    ["top-left", 0, "nwse-resize"],
    ["top-right", 0, "nesw-resize"],
    ["top-center", 0, "ns-resize"],
    ["middle-right", 0, "ew-resize"],
    ["bottom-right", 45, "ns-resize"],
    ["bottom-center", -90, "ew-resize"],
    ["bottom-left", 180, "nesw-resize"],
    ["middle-left", 450, "ns-resize"],
  ] as const)(
    "uses visible resize direction for %s at %s degrees",
    (position, rotation, expected) => {
      expect(selectionHandleCursor({ kind: "scale", point, position }, rotation)).toBe(expected);
    },
  );

  it.each([
    [{ kind: "rotate", point }, "grab"],
    [{ kind: "linear-endpoint", endpoint: "start", point }, "move"],
    [{ kind: "linear-bend", point }, "move"],
    [{ kind: "coordinate-origin", point }, "move"],
    [{ kind: "coordinate-axis", axisIndex: 0, point }, "move"],
    [{ kind: "table-header", point }, "ew-resize"],
    [{ kind: "table-column", separatorIndex: 0, point }, "ns-resize"],
  ] satisfies ReadonlyArray<readonly [SelectionHandle, string]>)(
    "maps structural handles",
    (handle, expected) => {
      expect(selectionHandleCursor(handle, 90)).toBe(expected);
    },
  );

  it("matches filled overlay hit semantics and interior handle priority", () => {
    const pointer = { pointerId: 1, pointerType: "pen" as const, x: 50, y: 50 };
    expect(selectionCursorContainsPoint(outline, pointer)).toBe(true);
    expect(selectionCursorContainsPoint(null, pointer)).toBe(false);
    expect(selectionCursorRadius(outline, pointer, 1)).toBe(10);
    expect(selectionCursorRadius(outline, { ...pointer, y: 5 }, 1)).toBe(16);
    expect(selectionCursorRadius(outline, { ...pointer, y: -5 }, 1)).toBe(16);
    expect(selectionCursorRadius(null, { ...pointer, pointerType: "touch" }, 0.5)).toBe(28);
    expect(selectionCursorRadius(null, { ...pointer, pointerType: "mouse" }, 4)).toBe(11);
  });
});
