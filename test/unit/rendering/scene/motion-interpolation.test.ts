import { describe, expect, it } from "vitest";

import type {
  ArrowElementV1,
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  StrokeElementV1,
  TableElementV1,
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

describe("scene motion progress and type compatibility", () => {
  it("uses the documented non-linear cubic-bezier curve", () => {
    expect(standardMotionProgress(0)).toBe(0);
    expect(standardMotionProgress(0.5)).toBeGreaterThan(0.8);
    expect(standardMotionProgress(1)).toBe(1);
    expect(standardMotionProgress(-1)).toBe(0);
    expect(standardMotionProgress(2)).toBe(1);
  });

  it("returns the target for completed and incompatible transitions", () => {
    const from = line(null);
    const to = box("rectangle");

    expect(interpolateElement(from, to, 0.5)).toBe(to);
    expect(interpolateElement(from, from, 1)).toBe(from);
  });

  it("interpolates strokes and preserves the target when point counts differ", () => {
    const from = stroke([0, 0, 0.2, 10, 10, 0.4]);
    const to = stroke([10, 20, 0.6, 30, 40, 0.8]);
    const current = interpolateElement(from, to, 0.5);

    expect(current.kind).toBe("stroke");
    if (current.kind === "stroke") {
      expect(current.points.slice(0, 5)).toEqual([5, 10, 0.4, 20, 25]);
      expect(current.points[5]).toBeCloseTo(0.6);
    }

    const differentPointCount = stroke([10, 20, 0.6]);
    expect(interpolateElement(from, differentPointCount, 0.5)).toBe(differentPointCount);
  });
});

describe("scene motion linear elements", () => {
  it("interpolates bend creation from the straight-line midpoint", () => {
    const from = line(null);
    const to = line({ x: 50, y: 80 });
    const current = interpolateElement(from, to, 0.5);

    expect(current.kind).toBe("line");
    if (current.kind === "line") expect(current.bend).toEqual({ x: 50, y: 40 });
  });

  it("interpolates arrows with filled nodes and bend removal", () => {
    const from = arrow(null, "triangle", "diamond");
    const to = arrow({ x: 80, y: 40 }, "circle", "none");
    const current = interpolateElement(from, to, 0.5);

    expect(current.kind).toBe("arrow");
    if (current.kind === "arrow") {
      expect(current.bend).toEqual({ x: 65, y: 20 });
      expect(current.startNode).toBe("circle");
      expect(current.endNode).toBe("none");
    }

    const noBend = arrow(null, "none", "none");
    expect(interpolateElement(noBend, noBend, 0.5)).toMatchObject({ bend: null });
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

describe("scene motion coordinate systems", () => {
  it("interpolates 3D coordinates and rejects dimension changes", () => {
    const from = coordinateSystem3d();
    const to: Extract<CoordinateSystemElementV1, { dimension: "3d" }> = {
      ...from,
      axes: [
        { x: 120, y: 100 },
        { x: 20, y: 200 },
        { x: 180, y: 160 },
      ],
    };
    const current = interpolateElement(from, to, 0.5);

    expect(current.kind).toBe("coordinate-system");
    if (current.kind === "coordinate-system") {
      expect(current.dimension).toBe("3d");
      expect(current.axes).toHaveLength(3);
      expect(current.axes[0]).toEqual({ x: 110, y: 100 });
    }

    const twoDimensional = coordinateSystem();
    expect(interpolateElement(from, twoDimensional, 0.5)).toBe(twoDimensional);
  });
});

describe("scene motion shapes and tables", () => {
  it("interpolates every box shape and table geometry", () => {
    const kinds: BoxShapeElementV1["kind"][] = [
      "rectangle",
      "ellipse",
      "triangle",
      "octagon",
      "parallelogram",
      "diamond",
    ];
    for (const kind of kinds) {
      const current = interpolateElement(box(kind), { ...box(kind), width: 80, x: 40 }, 0.5);
      expect(current).toMatchObject({ kind, width: 60, x: 30 });
    }

    const from = table();
    const to = { ...from, columnWidth: 80, headerHeight: 30, height: 200, x: 40, y: 60 };
    expect(interpolateElement(from, to, 0.5)).toMatchObject({
      columnWidth: 60,
      headerHeight: 25,
      height: 150,
      x: 30,
      y: 40,
    });
  });
});

const STROKE_STYLE = {
  color: { type: "rgba", value: "#112233FF" },
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5,
  width: 2,
} as const;

function stroke(points: number[]): StrokeElementV1 {
  return {
    createdAt: 1,
    id: "stroke",
    kind: "stroke",
    pivot: { x: 0, y: 0 },
    points,
    rotation: 0,
    style: STROKE_STYLE,
    tool: "pen",
  };
}

function arrow(
  bend: ArrowElementV1["bend"],
  startNode: ArrowElementV1["startNode"],
  endNode: ArrowElementV1["endNode"],
): ArrowElementV1 {
  return {
    bend,
    createdAt: 1,
    end: { x: 100, y: 0 },
    endConnection: null,
    endNode,
    id: "arrow",
    kind: "arrow",
    pivot: { x: 50, y: 0 },
    rotation: 0,
    start: { x: 0, y: 0 },
    startConnection: null,
    startNode,
    style: OUTLINE_STYLE,
  };
}

function box(kind: BoxShapeElementV1["kind"]): BoxShapeElementV1 {
  return {
    createdAt: 1,
    height: 40,
    id: kind,
    kind,
    pivot: { x: 20, y: 20 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "rgba", value: "#112233FF" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 40,
    x: 20,
    y: 20,
  };
}

function table(): TableElementV1 {
  return {
    columnWidth: 40,
    columns: 2,
    createdAt: 1,
    headerHeight: 20,
    height: 100,
    id: "table",
    kind: "table",
    pivot: { x: 20, y: 20 },
    rotation: 0,
    style: OUTLINE_STYLE,
    x: 20,
    y: 20,
  };
}

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

function coordinateSystem3d(): Extract<CoordinateSystemElementV1, { dimension: "3d" }> {
  return {
    axes: [
      { x: 100, y: 100 },
      { x: 20, y: 180 },
      { x: 160, y: 120 },
    ],
    createdAt: 1,
    dimension: "3d",
    id: "axes-3d",
    kind: "coordinate-system",
    origin: { x: 20, y: 100 },
    pivot: { x: 60, y: 140 },
    rotation: 0,
    style: OUTLINE_STYLE,
  };
}
