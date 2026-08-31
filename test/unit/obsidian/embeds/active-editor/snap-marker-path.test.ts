import { describe, expect, it } from "vitest";

import {
  selectionSnapGuidePath,
  snapMarkerPath,
} from "../../../../../src/obsidian/embeds/active-editor/snap-marker-path";

function bendGuidePath(alignment: "straight" | "symmetric"): string {
  return selectionSnapGuidePath(
    {
      alignment,
      curvePoint: { x: 50, y: 25 },
      end: { x: 100, y: 0 },
      kind: "bend",
      start: { x: 0, y: 0 },
    },
    (point) => point,
  );
}

describe("selection snap guide paths", () => {
  it("renders an anchor as a plain cross without an offset badge", () => {
    const path = snapMarkerPath({ x: 100, y: 200 });

    expect(path).toBe("M 92 200 L 108 200 M 100 192 L 100 208");
  });

  it("renders a rotation axis through the selection without a handle marker", () => {
    const path = selectionSnapGuidePath(
      {
        handle: { x: 100, y: 20 },
        kind: "rotation",
        opposite: { x: 100, y: 180 },
      },
      ({ x, y }) => ({ x: x * 2, y: y * 2 }),
    );

    expect(path).toBe("M 200 424 L 200 -24");
  });

  it("renders the complete bend chord only for a straight-line snap", () => {
    const path = bendGuidePath("straight");

    expect(path).toBe("M -64 0 L 164 0 M 42 25 L 58 25 M 50 17 L 50 33");
  });

  it("renders the perpendicular symmetry axis through the bend handle", () => {
    const path = bendGuidePath("symmetric");

    expect(path).toBe("M 50 -64 L 50 89 M 42 25 L 58 25 M 50 17 L 50 33");
  });

  it("extends angular and separator guides by constant screen pixels at every zoom", () => {
    const pageToScreen = ({ x, y }: { x: number; y: number }) => ({ x: x * 2, y: y * 2 });

    expect(
      selectionSnapGuidePath(
        { kind: "angular", start: { x: 10, y: 20 }, end: { x: 110, y: 20 } },
        pageToScreen,
      ),
    ).toBe("M -44 40 L 284 40");
    expect(
      selectionSnapGuidePath(
        {
          end: { x: 110, y: 20 },
          handle: { x: 60, y: 20 },
          kind: "separator",
          start: { x: 10, y: 20 },
        },
        pageToScreen,
      ),
    ).toBe("M -44 40 L 284 40 M 112 40 L 128 40 M 120 32 L 120 48");
  });
});
