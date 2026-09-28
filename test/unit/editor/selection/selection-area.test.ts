import {
  selectBySelectionAreaQuery,
  elementMatchesSelectionArea,
} from "../../../fixtures/editor/selection-query";
import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type {
  ArrowElementV1,
  BoxShapeElementV1,
  InkElementV1,
  LineElementV1,
  PointV1,
} from "../../../../src/domain/schema/public";
import { createRectangleSelectionArea } from "../../../../src/editor/selection/public";
import {
  createLassoSelectionArea,
  MAX_LASSO_SELECTION_POINTS,
} from "../../../../src/editor/selection/selection-area";
import { indexedPointInPolygon } from "../../../../src/editor/selection/lasso-edge-index";
import {
  pointInPolygonInclusive,
  segmentInsidePolygon,
} from "../../../../src/editor/selection/selection-polygon";
import { primitiveTouchesAreaSteps } from "../../../../src/editor/selection/selection-area-primitives";
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

    expect(area.bounds).toEqual({ minX: 5, minY: 10, maxX: 20, maxY: 30 });
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
    expect(area.bounds).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
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

it("does not retain an index for caller-owned mutable polygon points", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const area = {
    kind: "lasso" as const,
    points,
    bounds: { minX: 0, minY: 0, maxX: 16, maxY: 10 },
  };
  const target = { ...stroke(), points: [2, 2, 0.5] };
  expect(elementMatchesSelectionArea(area, target, "touched")).toBe(true);
  for (const point of points) point.x += 6;
  expect(elementMatchesSelectionArea(area, target, "touched")).toBe(false);
});

it("matches inclusive even-odd parity at self-crossings and boundaries", () => {
  const area = createLassoSelectionArea([
    { x: 0, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 10, y: 0 },
  ]);
  for (let x = -1; x <= 11; x += 0.5) {
    for (let y = -1; y <= 11; y += 0.5) {
      const point = { x, y };
      const query = indexedPointInPolygon(point, area.points, area.bounds);
      let result = query.next();
      while (!result.done) result = query.next();
      expect(result.value).toBe(pointInPolygonInclusive(point, area.points));
    }
  }
});

it("retains squared pressure-margin contact just outside an edge box", () => {
  const area = createLassoSelectionArea([
    { x: -1, y: 0.00002 },
    { x: 1, y: 0.00002 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0.00002 },
    { x: 3, y: -1 },
  ]);
  const steps = primitiveTouchesAreaSteps(area, {
    kind: "pressure-capsule",
    capsule: {
      start: { center: { x: 0, y: 0 }, radius: 0 },
      end: { center: { x: 0.5, y: 0 }, radius: 0 },
    },
  });
  let result = steps.next();
  while (!result.done) result = steps.next();
  expect(result.value).toBe(true);
});

it("preserves long segment enclosure near lasso endpoints", () => {
  const area = createLassoSelectionArea([
    { x: 0, y: 0 },
    { x: 1000000, y: 0 },
    { x: 1000000, y: 100 },
    { x: 600000, y: 100 },
    { x: 600000, y: 20 },
    { x: 400000, y: 20 },
    { x: 400000, y: 100 },
    { x: 0, y: 100 },
  ]);
  for (const offset of [-0.0005, -0.0001, 0, 0.0001, 0.0005]) {
    const start = { x: 100, y: 20 + offset };
    const end = { x: 999900, y: 20 - offset };
    const original = segmentInsidePolygon(start, end, area.points);
    const indexed = segmentInsidePolygon(start, end, area.points, area.bounds);
    let oldResult = original.next();
    let newResult = indexed.next();
    while (!oldResult.done) oldResult = original.next();
    while (!newResult.done) newResult = indexed.next();
    expect(newResult.value).toBe(oldResult.value);
  }
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
  it("includes interior pressure bulges even when the pen remains at one position", () => {
    const target = {
      ...stroke(),
      points: [20, 20, 0, 20, 20, 1, 20, 20, 0],
      pivot: { x: 20, y: 20 },
      style: { ...stroke().style, pressureEnabled: true, width: 8 as const },
    };
    const bulge = createRectangleSelectionArea({ x: 22.8, y: 19.9 }, { x: 23, y: 20.1 });
    const narrow = createRectangleSelectionArea({ x: 18, y: 16 }, { x: 22, y: 24 });

    expect(elementMatchesSelectionArea(bulge, target, "touched")).toBe(true);
    expect(elementMatchesSelectionArea(narrow, target, "fully-enclosed")).toBe(false);
  });

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

  it("includes the rounded outer contour of filled arrow nodes", () => {
    const target: ArrowElementV1 = {
      ...simpleArrow({ x: 10, y: 10 }, { x: 50, y: 10 }),
      endNode: "triangle",
      style: { ...outlineStyle, outlineWidth: 4 },
    };
    const outlineOnly = createRectangleSelectionArea({ x: 37, y: 18.1 }, { x: 41, y: 19 });

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
    const outerEdgeOnly = createRectangleSelectionArea({ x: 99, y: 350 }, { x: 101, y: 355 });
    const system = coordinateSystem();
    const arrowNodeOnly = createRectangleSelectionArea({ x: 489, y: 405 }, { x: 493, y: 408 });

    expect(elementMatchesSelectionArea(dividerOnly, targetTable, "touched")).toBe(true);
    expect(elementMatchesSelectionArea(outerEdgeOnly, targetTable, "touched")).toBe(false);
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
    expect(receivedBounds).toBe(area.bounds);
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

it.each(["triangle", "diamond", "circle"] as const)(
  "selects a filled %s contour at the rounded tip and excludes its exterior",
  (node) => {
    const target = {
      ...simpleArrow({ x: 10, y: 10 }, { x: 50, y: 10 }),
      endNode: node,
    };
    const tip = createRectangleSelectionArea({ x: 50.2, y: 9.9 }, { x: 50.8, y: 10.1 });
    const outside = createRectangleSelectionArea({ x: 51.1, y: 9.9 }, { x: 51.8, y: 10.1 });
    expect(elementMatchesSelectionArea(tip, target, "touched")).toBe(true);
    expect(elementMatchesSelectionArea(outside, target, "touched")).toBe(false);
  },
);

it.each(["triangle", "diamond"] as const)(
  "includes the exact circular %s boundary between former approximation chords",
  (node) => {
    const target = {
      ...simpleArrow({ x: 10, y: 10 }, { x: 50, y: 10 }),
      endNode: node,
    };
    const cornerX = node === "triangle" ? 38 : 44;
    for (const [radius, expected] of [
      [0.9999, true],
      [1.0001, false],
    ] as const) {
      const x = cornerX + radius * Math.cos(1.4);
      const y = 16 + radius * Math.sin(1.4);
      const area = createRectangleSelectionArea(
        { x: x - 0.00001, y: y - 0.00001 },
        { x: x + 0.00001, y: y + 0.00001 },
      );
      expect(elementMatchesSelectionArea(area, target, "touched")).toBe(expected);
    }
    const enclosed = createRectangleSelectionArea({ x: 0, y: 0 }, { x: 60, y: 17 });
    const clipped = createRectangleSelectionArea({ x: 0, y: 0 }, { x: 60, y: 16.9999 });
    expect(elementMatchesSelectionArea(enclosed, target, "fully-enclosed")).toBe(true);
    expect(elementMatchesSelectionArea(clipped, target, "fully-enclosed")).toBe(false);
  },
);
