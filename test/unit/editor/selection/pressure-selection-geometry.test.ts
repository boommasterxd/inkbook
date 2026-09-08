import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";
import { elementContainsPoint } from "../../../../src/editor/selection/hit-test";
import {
  createRectangleSelectionArea,
  elementMatchesSelectionArea,
} from "../../../../src/editor/selection/selection-area";
import { stroke } from "../../domain/schema/fixtures";

function pressureStroke(points: number[]): StrokeElementV1 {
  return {
    ...stroke(),
    points,
    pivot: { x: 0, y: 0 },
    style: { ...stroke().style, pressureEnabled: true, width: 2 },
  };
}

describe("canonical pressure selection geometry", () => {
  it("changes painted widths continuously within the former quantization levels", () => {
    const thin = pressureStroke([0, 0, 0.5, 20, 0, 0.5]);
    const thick = pressureStroke([0, 0, 0.52, 20, 0, 0.52]);
    const edge = { x: 10, y: 0.682 };
    const area = createRectangleSelectionArea({ x: 9.99, y: 0.681 }, { x: 10.01, y: 0.683 });
    expect(elementContainsPoint(thin, edge, 0)).toBe(false);
    expect(elementContainsPoint(thick, edge, 0)).toBe(true);
    expect(elementMatchesSelectionArea(area, thin, "touched")).toBe(false);
    expect(elementMatchesSelectionArea(area, thick, "touched")).toBe(true);
  });

  it("excludes the inward half of a large taper cap beyond the painted endpoint", () => {
    const target = pressureStroke([0, 0, 1, 0.2, 0, 0]);
    const outside = createRectangleSelectionArea({ x: 0.79, y: -0.01 }, { x: 0.81, y: 0.01 });
    expect(elementContainsPoint(target, { x: 0.8, y: 0 }, 0)).toBe(false);
    expect(elementMatchesSelectionArea(outside, target, "touched")).toBe(false);
  });

  it("keeps subpixel movements selectable when canonical endpoint centers coincide", () => {
    const target = pressureStroke([0, 0, 1, 0.0001, 0, 1]);
    expect(elementContainsPoint(target, { x: 0.9, y: 0 }, 0)).toBe(true);
    expect(elementContainsPoint(target, { x: -0.9, y: 0 }, 0)).toBe(true);
  });

  it("keeps tight self-overlaps selectable as painted regions", () => {
    const target = pressureStroke([0, 0, 1, 2, 2, 1, 0, 4, 1, 2, 2, 1, 4, 4, 1]);
    const area = createRectangleSelectionArea({ x: 1.99, y: 2.49 }, { x: 2.01, y: 2.51 });
    expect(elementContainsPoint(target, { x: 2, y: 2.5 }, 0)).toBe(true);
    expect(elementMatchesSelectionArea(area, target, "touched")).toBe(true);
  });

  it("uses local pressure widths and round endpoint caps for point and area selection", () => {
    const target = pressureStroke([0, 0, 0, 20, 0, 0]);
    const paint = createRectangleSelectionArea({ x: 9, y: 0.3 }, { x: 11, y: 0.34 });
    const empty = createRectangleSelectionArea({ x: 9, y: 0.4 }, { x: 11, y: 0.5 });

    expect(elementContainsPoint(target, { x: 10, y: 0.34 }, 0)).toBe(true);
    expect(elementContainsPoint(target, { x: 10, y: 0.4 }, 0)).toBe(false);
    expect(elementContainsPoint(target, { x: -0.34, y: 0 }, 0)).toBe(true);
    expect(elementContainsPoint(target, { x: -0.4, y: 0 }, 0)).toBe(false);
    expectPaintedArea(target, paint, empty);
  });

  it("matches the rotated quadratic paint instead of its control polygon", () => {
    const target = { ...pressureStroke([0, 0, 1, 20, 40, 1, 40, 0, 1]), rotation: 90 };
    const paint = createRectangleSelectionArea({ x: -15.1, y: 19.9 }, { x: -14.9, y: 20.1 });
    const empty = createRectangleSelectionArea({ x: -20.1, y: 19.9 }, { x: -19.9, y: 20.1 });

    expect(elementContainsPoint(target, { x: -15, y: 20 }, 0)).toBe(true);
    expect(elementContainsPoint(target, { x: -20, y: 20 }, 0)).toBe(false);
    expectPaintedArea(target, paint, empty);
  });

  it("retains continuous pressure caps within conservative spatial bounds", () => {
    const target = pressureStroke([0, 0, 0.99, 20, 0, 0.99]);
    expect(elementContainsPoint(target, { x: 20.99, y: 0 }, 0)).toBe(true);
    expect(elementContainsPoint(target, { x: 20.998, y: 0 }, 0)).toBe(false);
    expect(calculateElementBounds(target)).toEqual({ minX: -1, minY: -1, maxX: 21, maxY: 1 });
  });

  it("keeps indexed and complete-outline hits equal across packed run boundaries", () => {
    const points = Array.from({ length: 130 }, (_, index) => [
      index * 0.1,
      0,
      (index % 7) / 7,
    ]).flat();
    Object.freeze(points);
    const target = pressureStroke(points);
    for (const x of [0.35, 6.35, 6.7, 6.8, 12.75]) {
      for (const y of [0.45, 0.65, 0.85]) {
        const area = createRectangleSelectionArea(
          { x: x - 0.00001, y: y - 0.00001 },
          { x: x + 0.00001, y: y + 0.00001 },
        );
        expect(elementContainsPoint(target, { x, y }, 0)).toBe(
          elementMatchesSelectionArea(area, target, "touched"),
        );
      }
    }
  });

  it("does not leave gaps at cached curve-block boundaries or after a width change", () => {
    const points = Array.from({ length: 130 }, (_, index) => [index, 0, 0]).flat();
    Object.freeze(points);
    const target = pressureStroke(points);
    for (const x of [0, 63.5, 64, 64.5, 127.5, 128, 129]) {
      expect(elementContainsPoint(target, { x, y: 0 }, 0)).toBe(true);
    }
    expect(elementContainsPoint(target, { x: 128, y: 0.5 }, 0)).toBe(false);
    const wider = { ...target, style: { ...target.style, width: 8 as const } };
    expect(elementContainsPoint(wider, { x: 128, y: 0.5 }, 0)).toBe(true);
    expect(
      elementContainsPoint({ ...wider, style: { ...wider.style, opacity: 0 } }, { x: 0, y: 0 }, 1),
    ).toBe(false);
  });
});

function expectPaintedArea(
  target: StrokeElementV1,
  paint: ReturnType<typeof createRectangleSelectionArea>,
  empty: ReturnType<typeof createRectangleSelectionArea>,
): void {
  expect(elementMatchesSelectionArea(paint, target, "touched")).toBe(true);
  expect(elementMatchesSelectionArea(empty, target, "touched")).toBe(false);
}
