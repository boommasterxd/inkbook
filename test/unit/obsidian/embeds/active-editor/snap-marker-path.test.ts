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
        center: { x: 100, y: 100 },
        handle: { x: 100, y: 20 },
        kind: "rotation",
      },
      ({ x, y }) => ({ x: x * 2, y: y * 2 }),
    );

    expect(path).toBe("M 200 360 L 200 40");
  });

  it("renders the complete bend chord only for a straight-line snap", () => {
    const path = bendGuidePath("straight");

    expect(path).toBe("M 0 0 L 100 0 M 42 25 L 58 25 M 50 17 L 50 33");
  });

  it("renders the perpendicular symmetry axis through the bend handle", () => {
    const path = bendGuidePath("symmetric");

    expect(path).toBe("M 50 -8 L 50 33 M 42 25 L 58 25 M 50 17 L 50 33");
  });
});
