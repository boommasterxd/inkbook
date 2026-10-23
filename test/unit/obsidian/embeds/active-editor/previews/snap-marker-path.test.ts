import { describe, expect, it } from "vitest";

import {
  selectionSnapGuidePath,
  snapMarkerPath,
} from "../../../../../../src/obsidian/embeds/active-editor/previews/snap-marker-path";

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
  it("extends an anchor cross by 12 screen pixels in every direction", () => {
    const path = snapMarkerPath({ x: 100, y: 200 });

    expect(path).toBe("M 88 200 L 112 200 M 100 188 L 100 212");
  });

  it("keeps anchor cross extensions constant at every zoom", () => {
    const guide = { kind: "anchor" as const, point: { x: 10, y: 20 } };

    expect(selectionSnapGuidePath(guide, ({ x, y }) => ({ x: x * 0.5, y: y * 0.5 }))).toBe(
      "M -7 10 L 17 10 M 5 -2 L 5 22",
    );
    expect(selectionSnapGuidePath(guide, ({ x, y }) => ({ x: x * 4, y: y * 4 }))).toBe(
      "M 28 80 L 52 80 M 40 68 L 40 92",
    );
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

    expect(path).toBe("M 200 384 L 200 16");
  });

  it("renders the complete bend chord only for a straight-line snap", () => {
    const path = bendGuidePath("straight");

    expect(path).toBe("M -24 0 L 124 0");
  });

  it("renders the perpendicular symmetry axis through the bend handle", () => {
    const path = bendGuidePath("symmetric");

    expect(path).toBe("M 50 -24 L 50 49");
  });

  it("extends angular and separator guides by constant screen pixels at every zoom", () => {
    const pageToScreen = ({ x, y }: { x: number; y: number }) => ({ x: x * 2, y: y * 2 });

    expect(
      selectionSnapGuidePath(
        { kind: "angular", start: { x: 10, y: 20 }, end: { x: 110, y: 20 } },
        pageToScreen,
      ),
    ).toBe("M -4 40 L 244 40");
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
    ).toBe("M -4 40 L 244 40");
  });

  it("renders every simultaneous coordinate-origin angular guide", () => {
    const path = selectionSnapGuidePath(
      {
        additionalStarts: [
          { x: 50, y: -100 },
          { x: -50, y: 100 },
        ],
        end: { x: 50, y: 50 },
        kind: "angular",
        start: { x: -100, y: 50 },
      },
      (point) => point,
    );

    expect(path).toBe(
      "M -124 50 L 74 50 M 50 -124 L 50 74 M -71.46625258399798 110.73312629199899 L 71.46625258399798 39.26687370800101",
    );
  });
});
