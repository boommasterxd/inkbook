import { describe, expect, it } from "vitest";

import type {
  CoordinateSystemElementV1,
  LineElementV1,
  StraightHighlighterElementV1,
} from "../../../../src/domain/schema/public";
import {
  interpolateElement,
  standardMotionProgress,
} from "../../../../src/rendering/scene/motion-interpolation";

type CoordinateSystem2d = CoordinateSystemElementV1 & {
  readonly axes: readonly [
    { readonly x: number; readonly y: number },
    { readonly x: number; readonly y: number },
  ];
  readonly dimension: "2d";
};

const OUTLINE_STYLE = {
  outlineColor: { type: "rgba", value: "#112233FF" },
  outlineOpacity: 1,
  outlineStyle: "solid",
  outlineWidth: 2,
} as const;

describe("scene motion interpolation", () => {
  it("uses the documented non-linear cubic-bezier curve", () => {
    expect(standardMotionProgress(0)).toBe(0);
    expect(standardMotionProgress(0.5)).toBeGreaterThan(0.8);
    expect(standardMotionProgress(1)).toBe(1);
  });

  it("interpolates bend creation from the straight-line midpoint", () => {
    const from = line(null);
    const to = line({ x: 50, y: 80 });
    const current = interpolateElement(from, to, 0.5);

    expect(current.kind).toBe("line");
    if (current.kind === "line") expect(current.bend).toEqual({ x: 50, y: 40 });
  });

  it("preserves straight-highlighter and coordinate tuple invariants", () => {
    const highlighter = straightHighlighter();
    const current = interpolateElement(
      highlighter,
      { ...highlighter, end: { x: 140, y: 40 } },
      0.5,
    );
    expect(current.kind === "straight-highlighter" && current.bend).toBe(null);

    const axes = coordinateSystem();
    const moved = interpolateElement(
      axes,
      {
        ...axes,
        axes: [
          { x: 120, y: 100 },
          { x: 20, y: 200 },
        ],
      },
      0.5,
    );
    expect(moved.kind === "coordinate-system" && moved.dimension).toBe("2d");
    if (moved.kind === "coordinate-system") expect(moved.axes).toHaveLength(2);
  });
});

function line(bend: LineElementV1["bend"]): LineElementV1 {
  return {
    bend,
    createdAt: 1,
    end: { x: 100, y: 0 },
    endConnection: null,
    endNode: "none",
    id: "line",
    kind: "line",
    pivot: { x: 50, y: 0 },
    rotation: 0,
    start: { x: 0, y: 0 },
    startConnection: null,
    startNode: "none",
    style: OUTLINE_STYLE,
  };
}

function straightHighlighter(): StraightHighlighterElementV1 {
  return {
    bend: null,
    createdAt: 1,
    end: { x: 100, y: 20 },
    endNode: "none",
    id: "highlight",
    kind: "straight-highlighter",
    pivot: { x: 50, y: 10 },
    rotation: 0,
    start: { x: 0, y: 0 },
    startNode: "none",
    style: {
      color: { type: "rgba", value: "#FFFF0080" },
      opacity: 0.5,
      pressureEnabled: false,
      smoothing: 0.5,
      width: 8,
    },
  };
}

function coordinateSystem(): CoordinateSystem2d {
  return {
    axes: [
      { x: 100, y: 100 },
      { x: 20, y: 180 },
    ],
    createdAt: 1,
    dimension: "2d",
    id: "axes",
    kind: "coordinate-system",
    origin: { x: 20, y: 100 },
    pivot: { x: 60, y: 140 },
    rotation: 0,
    style: OUTLINE_STYLE,
  };
}
