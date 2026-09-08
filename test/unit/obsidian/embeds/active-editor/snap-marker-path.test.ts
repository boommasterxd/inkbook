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
  it("extends an anchor cross by 24 screen pixels in every direction", () => {
    const path = snapMarkerPath({ x: 100, y: 200 });

    expect(path).toBe("M 76 200 L 124 200 M 100 176 L 100 224");
  });

  it("keeps anchor cross extensions constant at every zoom", () => {
    const guide = { kind: "anchor" as const, point: { x: 10, y: 20 } };

    expect(selectionSnapGuidePath(guide, ({ x, y }) => ({ x: x * 0.5, y: y * 0.5 }))).toBe(
      "M -19 10 L 29 10 M 5 -14 L 5 34",
    );
    expect(selectionSnapGuidePath(guide, ({ x, y }) => ({ x: x * 4, y: y * 4 }))).toBe(
      "M 16 80 L 64 80 M 40 56 L 40 104",
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

    expect(path).toBe("M 200 424 L 200 -24");
  });

  it("renders the complete bend chord only for a straight-line snap", () => {
    const path = bendGuidePath("straight");

    expect(path).toBe("M -64 0 L 164 0");
  });

  it("renders the perpendicular symmetry axis through the bend handle", () => {
    const path = bendGuidePath("symmetric");

    expect(path).toBe("M 50 -64 L 50 89");
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
    ).toBe("M -44 40 L 284 40");
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
      "M -164 50 L 114 50 M 50 -164 L 50 114 M -107.24334022399461 128.6216701119973 L 107.24334022399461 21.378329888002693",
    );
  });
});
