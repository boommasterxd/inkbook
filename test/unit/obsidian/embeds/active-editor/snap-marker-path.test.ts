import { describe, expect, it } from "vitest";

import {
  selectionSnapGuidePath,
  snapMarkerPath,
} from "../../../../../src/obsidian/embeds/active-editor/snap-marker-path";

describe("selection snap guide paths", () => {
  it("keeps an anchor cross visible beside a covered pointer", () => {
    const path = snapMarkerPath({ x: 100, y: 200 });

    expect(path).toContain("M 92 200 L 108 200");
    expect(path).toContain("M 124 171");
  });

  it("renders a radial rotation guide and an offset marker", () => {
    const path = selectionSnapGuidePath(
      {
        center: { x: 100, y: 100 },
        handle: { x: 100, y: 20 },
        kind: "rotation",
      },
      ({ x, y }) => ({ x: x * 2, y: y * 2 }),
    );

    expect(path).toContain("M 200 200 L 200 40");
    expect(path).toContain("M 192 40 L 208 40");
    expect(path).toContain("M 224 11");
  });

  it("renders the complete bend chord and marks its snapped curve point", () => {
    const path = selectionSnapGuidePath(
      {
        curvePoint: { x: 50, y: 25 },
        end: { x: 100, y: 0 },
        kind: "bend",
        start: { x: 0, y: 0 },
      },
      (point) => point,
    );

    expect(path).toContain("M 0 0 L 100 0");
    expect(path).toContain("M 42 25 L 58 25");
    expect(path).toContain("M 74 -4");
  });
});
