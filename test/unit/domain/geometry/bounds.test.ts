import type { ArrowElementV1, PageV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { describe, expect, it } from "vitest";

import {
  boundsCorrection,
  boundsIntersect,
  calculateElementBounds,
  derivePageExtent,
  effectiveStrokeWidth,
} from "../../../../src/domain/geometry/public";
import { outlineStyle, rectangle, strokeStyle, table } from "./fixtures";

describe("shared conservative element bounds", () => {
  it("includes quadratic extrema and half the visible outline width", () => {
    const arrow: ArrowElementV1 = {
      id: "00000000-0000-4000-8000-000000000006",
      createdAt: 0,
      kind: "arrow",
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
      bend: { x: 10, y: 20 },
      startNode: "none",
      endNode: "none",
      startConnection: null,
      endConnection: null,
      rotation: 0,
      pivot: { x: 10, y: 0 },
      style: outlineStyle,
    };
    expect(calculateElementBounds(arrow)).toEqual({ minX: -1, minY: -1, maxX: 21, maxY: 11 });
  });

  it("includes arrow-node and rotated closed-shape extents", () => {
    const arrow: ArrowElementV1 = {
      id: "00000000-0000-4000-8000-000000000007",
      createdAt: 0,
      kind: "arrow",
      start: { x: 20, y: 20 },
      end: { x: 100, y: 20 },
      bend: null,
      startNode: "circle",
      endNode: "triangle",
      startConnection: null,
      endConnection: null,
      rotation: 0,
      pivot: { x: 60, y: 20 },
      style: outlineStyle,
    };
    const bounds = calculateElementBounds(arrow);
    expect(bounds.minX).toBeLessThan(20);
    expect(bounds.maxX).toBeGreaterThanOrEqual(101);
    const rotatedBounds = calculateElementBounds(rectangle({ rotation: 90 }));
    expect(rotatedBounds.minX).toBeCloseTo(24);
    expect(rotatedBounds.minY).toBeCloseTo(-26);
    expect(rotatedBounds.maxX).toBeCloseTo(76);
    expect(rotatedBounds.maxY).toBeCloseTo(76);
  });

  it("uses highlighter effective width and pressure-stroke maximum width", () => {
    const highlighter: StrokeElementV1 = {
      id: "00000000-0000-4000-8000-000000000008",
      createdAt: 0,
      kind: "stroke",
      tool: "highlighter",
      points: [10, 10, 0.5],
      rotation: 0,
      pivot: { x: 10, y: 10 },
      style: { ...strokeStyle, pressureEnabled: false },
    };
    expect(effectiveStrokeWidth(highlighter)).toBe(20);
    expect(calculateElementBounds(highlighter)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
  });

  it("provides horizontal and top-edge corrections without underflow", () => {
    expect(boundsCorrection({ minX: -5, minY: -3, maxX: 100, maxY: 20 })).toEqual({ x: 5, y: 3 });
    expect(boundsCorrection({ minX: 2000, minY: 0, maxX: 2100, maxY: 10 })?.x).toBeCloseTo(-51.4);
    expect(boundsCorrection({ minX: -1, minY: 0, maxX: 2050, maxY: 10 })).toBeNull();
    expect(
      boundsIntersect(
        { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        { minX: 10, minY: 10, maxX: 20, maxY: 20 },
      ),
    ).toBe(true);
  });

  it("derives active and locked heights on background-aligned rows", () => {
    const page: PageV1 = {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "lines", spacing: 50 },
      writingLineHeight: 80,
      activeBufferLines: 3,
      lockedBufferLines: 1,
    };
    expect(derivePageExtent(page, null)).toMatchObject({
      backgroundStep: 50,
      bufferUnit: 100,
      occupiedRows: 0,
      activeHeight: 348.6,
      lockedHeight: 148.6,
    });
    expect(derivePageExtent(page, calculateElementBounds(table()).maxY).occupiedRows).toBe(2);
  });
});
