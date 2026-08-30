import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type {
  ArrowElementV1,
  BoxShapeElementV1,
  InkElementV1,
  LineElementV1,
  PointV1,
} from "../../../../src/domain/schema/public";
import {
  createLassoSelectionArea,
  createRectangleSelectionArea,
  elementMatchesSelectionArea,
  MAX_LASSO_SELECTION_POINTS,
  selectBySelectionAreaQuery,
  selectionAreaBounds,
} from "../../../../src/editor/selection/public";
import {
  arrow,
  coordinateSystem,
  line,
  outlineStyle,
  rectangle,
  stroke,
  table,
} from "../../domain/schema/fixtures";

describe("selection area creation", () => {
  it("normalizes rectangle direction and protects the resulting geometry", () => {
    const area = createRectangleSelectionArea({ x: 20, y: 30 }, { x: 5, y: 10 });

    expect(selectionAreaBounds(area)).toEqual({ minX: 5, minY: 10, maxX: 20, maxY: 30 });
    expect(area.points).toEqual([
      { x: 5, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 30 },
      { x: 5, y: 30 },
    ]);
    expect(Object.isFrozen(area)).toBe(true);
    expect(Object.isFrozen(area.points)).toBe(true);
  });

  it("closes a bounded freeform lasso without retaining caller-owned points", () => {
    const input = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 10, y: 20 },
      { x: 0, y: 0 },
    ];
    const area = createLassoSelectionArea(input);
    input[1]!.x = 999;

    expect(area.points).toHaveLength(3);
    expect(area.points[1]).toEqual({ x: 20, y: 0 });
    expect(selectionAreaBounds(area)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
  });

  it("rejects malformed and excessive lasso input before geometry work", () => {
    expect(() =>
      createLassoSelectionArea([
        { x: 0, y: 0 },
        { x: Number.NaN, y: 1 },
        { x: 1, y: 2 },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      createLassoSelectionArea([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      createLassoSelectionArea(
        Array.from({ length: MAX_LASSO_SELECTION_POINTS + 1 }, (_, index) => ({
          x: index,
          y: index % 2,
        })),
      ),
    ).toThrow(RangeError);
  });
});

describe("selection area inclusion", () => {
  it("uses even-odd inclusion for a lasso that loops around the same area twice", () => {
    const area = createLassoSelectionArea([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    const target = {
      ...rectangle(),
      height: 2,
      pivot: { x: 5, y: 5 },
      style: {
        ...rectangle().style,
        fillColor: { type: "rgba" as const, value: "#112233FF" as const },
        fillOpacity: 1,
      },
      width: 2,
      x: 4,
      y: 4,
    };

    expect(elementMatchesSelectionArea(area, target, "touched")).toBe(false);
  });

  it("distinguishes touched from fully enclosed using line width", () => {
    const target = simpleLine({ x: 10, y: 10 }, { x: 30, y: 10 }, 4);
    const touching = createRectangleSelectionArea({ x: 5, y: 5 }, { x: 35, y: 11 });
    const enclosing = createRectangleSelectionArea({ x: 5, y: 5 }, { x: 35, y: 12 });

    expect(elementMatchesSelectionArea(touching, target, "touched")).toBe(true);
    expect(elementMatchesSelectionArea(touching, target, "fully-enclosed")).toBe(false);
    expect(elementMatchesSelectionArea(enclosing, target, "fully-enclosed")).toBe(true);
  });

  it("does not treat concave-lasso endpoints as proof of full enclosure", () => {
    const area = createLassoSelectionArea([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 7 },
      { x: 7, y: 7 },
      { x: 7, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    const target = simpleLine({ x: 1, y: 5 }, { x: 9, y: 5 }, 2);

    expect(elementMatchesSelectionArea(area, target, "touched")).toBe(true);
    expect(elementMatchesSelectionArea(area, target, "fully-enclosed")).toBe(false);
  });

  it("selects a lasso contained within visible fill but not within an empty shape", () => {
    const area = createLassoSelectionArea([
      { x: 140, y: 140 },
      { x: 160, y: 140 },
      { x: 150, y: 160 },
    ]);
    const empty = rectangle();
    const filled = {
      ...empty,
      style: {
        ...empty.style,
        fillColor: { type: "rgba" as const, value: "#112233FF" as const },
        fillOpacity: 1,
      },
    };

    expect(elementMatchesSelectionArea(area, empty, "touched")).toBe(false);
    expect(elementMatchesSelectionArea(area, filled, "touched")).toBe(true);
  });

  it("uses rotated page geometry instead of unrotated box coordinates", () => {
    const target: BoxShapeElementV1 = { ...rectangle(), rotation: 45 };
    const rotatedTop = createRectangleSelectionArea({ x: 146, y: 77 }, { x: 154, y: 83 });
    const oldTopLeft = createRectangleSelectionArea({ x: 98, y: 98 }, { x: 102, y: 102 });

    expect(elementMatchesSelectionArea(rotatedTop, target, "touched")).toBe(true);
    expect(elementMatchesSelectionArea(oldTopLeft, target, "touched")).toBe(false);
  });

  it("includes freehand stroke thickness and rotation", () => {
    const target = {
      ...stroke(),
      rotation: 90,
      points: [100, 100, 1, 120, 100, 1],
      pivot: { x: 110, y: 100 },
      style: { ...stroke().style, pressureEnabled: false, width: 8 as const },
    };
    const edge = createRectangleSelectionArea({ x: 112.5, y: 105 }, { x: 114, y: 115 });

    expect(elementMatchesSelectionArea(edge, target, "touched")).toBe(true);
    expect(elementMatchesSelectionArea(edge, target, "fully-enclosed")).toBe(false);
  });
});

describe("selection area element geometry", () => {
  it("matches curved line geometry at the bend instead of only its chord", () => {
    const target: LineElementV1 = {
      ...simpleLine({ x: 10, y: 20 }, { x: 50, y: 20 }, 2),
      bend: { x: 30, y: 60 },
      pivot: { x: 30, y: 20 },
    };
    const nearCurve = createRectangleSelectionArea({ x: 27, y: 38 }, { x: 33, y: 42 });

    expect(elementMatchesSelectionArea(nearCurve, target, "touched")).toBe(true);
  });

  it("matches filled arrow nodes outside the line body", () => {
    const target: ArrowElementV1 = {
      ...simpleArrow({ x: 10, y: 10 }, { x: 50, y: 10 }),
      endNode: "triangle",
    };
    const nodeOnly = createRectangleSelectionArea({ x: 39, y: 14 }, { x: 43, y: 17 });

    expect(elementMatchesSelectionArea(nodeOnly, target, "touched")).toBe(true);
  });

  it("includes the outline width around closed arrow nodes", () => {
    const target: ArrowElementV1 = {
      ...simpleArrow({ x: 10, y: 10 }, { x: 50, y: 10 }),
      endNode: "triangle",
      style: { ...outlineStyle, outlineWidth: 4 },
    };
    const outlineOnly = createRectangleSelectionArea({ x: 37, y: 17 }, { x: 41, y: 18 });

    expect(elementMatchesSelectionArea(outlineOnly, target, "touched")).toBe(true);
  });

  it("fully encloses a tapered pressure stroke without applying its maximum radius everywhere", () => {
    const target = {
      ...stroke(),
      points: [0, 0, 1, 20, 0, 0],
      pivot: { x: 10, y: 0 },
      style: { ...stroke().style, pressureEnabled: true, width: 22 as const },
    };
    const taperedArea = createLassoSelectionArea([
      { x: -12, y: -12 },
      { x: 1, y: -12 },
      { x: 26, y: -5 },
      { x: 26, y: 5 },
      { x: 1, y: 12 },
      { x: -12, y: 12 },
    ]);

    expect(elementMatchesSelectionArea(taperedArea, target, "fully-enclosed")).toBe(true);
  });

  it("matches table dividers and coordinate-system arrow nodes", () => {
    const targetTable = table();
    const dividerOnly = createRectangleSelectionArea({ x: 139, y: 320 }, { x: 141, y: 325 });
    const system = coordinateSystem();
    const arrowNodeOnly = createRectangleSelectionArea({ x: 489, y: 405 }, { x: 493, y: 408 });

    expect(elementMatchesSelectionArea(dividerOnly, targetTable, "touched")).toBe(true);
    expect(elementMatchesSelectionArea(arrowNodeOnly, system, "touched")).toBe(true);
  });

  it("ignores elements whose paint is fully transparent", () => {
    const target = { ...line(), style: { ...line().style, outlineOpacity: 0 } };
    const area = createRectangleSelectionArea({ x: 190, y: 140 }, { x: 310, y: 160 });

    expect(elementMatchesSelectionArea(area, target, "touched")).toBe(false);
    expect(elementMatchesSelectionArea(area, target, "fully-enclosed")).toBe(false);
  });
});

describe("selection area query", () => {
  it("requests only broadphase bounds and preserves additive and no-op identity behavior", () => {
    const area = createRectangleSelectionArea({ x: 90, y: 90 }, { x: 210, y: 210 });
    const inside = rectangle();
    const outside = { ...rectangle(30), x: 500, y: 500, pivot: { x: 550, y: 550 } };
    let receivedBounds: unknown;
    const query = (
      bounds: ReturnType<typeof calculateElementBounds>,
      sink: {
        add(
          id: string,
          candidateBounds: ReturnType<typeof calculateElementBounds>,
          element: InkElementV1,
        ): void;
      },
    ) => {
      receivedBounds = bounds;
      sink.add(inside.id, calculateElementBounds(inside), inside);
      sink.add(outside.id, calculateElementBounds(outside), outside);
    };

    const initial = new Set(["existing"]);
    const next = selectBySelectionAreaQuery(initial, area, "touched", true, query);
    expect(receivedBounds).toBe(selectionAreaBounds(area));
    expect([...next]).toEqual(["existing", inside.id]);
    expect(selectBySelectionAreaQuery(next, area, "touched", true, query)).toBe(next);
  });
});

function simpleLine(start: PointV1, end: PointV1, width: 1 | 2 | 4 | 8 | 12): LineElementV1 {
  return {
    ...line(),
    start,
    end,
    bend: null,
    pivot: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    startConnection: null,
    style: { ...outlineStyle, outlineWidth: width },
  };
}

function simpleArrow(start: PointV1, end: PointV1): ArrowElementV1 {
  return {
    ...arrow(),
    start,
    end,
    bend: null,
    pivot: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    startConnection: null,
    endConnection: null,
    startNode: "none",
    endNode: "arrow",
    style: { ...outlineStyle, outlineWidth: 2 },
  };
}
