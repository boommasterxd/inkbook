import { describe, expect, it } from "vitest";

import type { PressureOutlinePiece } from "../../../../src/domain/geometry/pressure-outline";
import { visitPressureSelectionPrimitives } from "../../../../src/editor/selection/pressure-selection-primitives";
import { createRectangleSelectionArea } from "../../../../src/editor/selection/selection-area";
import { primitiveTouchesArea } from "../../../../src/editor/selection/selection-area-primitives";

describe("packed pressure-strip selection boundaries", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("includes only enabled endpoint caps (start=%s, end=%s)", (startCap, endCap) => {
    const piece: PressureOutlinePiece = {
      kind: "strip",
      left: [
        { x: 0, y: 1 },
        { x: 5, y: 1 },
        { x: 10, y: 1 },
      ],
      right: [
        { x: 0, y: -1 },
        { x: 5, y: -1 },
        { x: 10, y: -1 },
      ],
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      startRadius: 1,
      endRadius: 1,
      startCap,
      endCap,
    };
    expect(touches(piece, -0.5)).toBe(startCap);
    expect(touches(piece, 10.5)).toBe(endCap);
    expect(touches(piece, 5)).toBe(true);
  });
});

function touches(piece: PressureOutlinePiece, x: number): boolean {
  const area = createRectangleSelectionArea({ x: x - 0.01, y: -0.01 }, { x: x + 0.01, y: 0.01 });
  return !visitPressureSelectionPrimitives(
    piece,
    (primitive) => !primitiveTouchesArea(area, primitive),
  );
}
