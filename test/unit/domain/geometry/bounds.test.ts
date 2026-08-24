import type { ArrowElementV1, PageV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { describe, expect, it } from "vitest";

import {
  boundsIntersect,
  calculateElementBounds,
  deriveLegacyLockedHeight,
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

  it("detects bounds that touch at their edges", () => {
    expect(
      boundsIntersect(
        { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        { minX: 10, minY: 10, maxX: 20, maxY: 20 },
      ),
    ).toBe(true);
  });
});

describe("page extent bounds", () => {
  it("derives active and locked heights on background-aligned rows", () => {
    const page: PageV1 = {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "lines", spacing: 50 },
      writingLineHeight: 80,
      activeBufferLines: 3,
      lockedBufferLines: 1,
    };
    const emptyExtent = derivePageExtent(page, null);
    expect(emptyExtent).toMatchObject({
      backgroundStep: 50,
      bufferUnit: 100,
      occupiedRows: 0,
      activeHeight: 348.6,
    });
    expect(emptyExtent.lockedHeight).toBeCloseTo(248.6);
    expect(derivePageExtent(page, calculateElementBounds(table()).maxY).occupiedRows).toBe(2);
  });

  it("keeps an empty page at least two and a half writing lines tall", () => {
    const page: PageV1 = {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "squares", spacing: 40 },
      writingLineHeight: 100,
      activeBufferLines: 1,
      lockedBufferLines: 0,
    };

    expect(derivePageExtent(page, null)).toMatchObject({
      activeHeight: 328.6,
      lockedHeight: 328.6,
    });
    expect(derivePageExtent(page, page.margin + 40).lockedHeight).toBe(128.6);
  });

  it("keeps exactly one complete pattern row after occupied content when locked", () => {
    const page: PageV1 = {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "squares", spacing: 40 },
      writingLineHeight: 100,
      activeBufferLines: 3,
      lockedBufferLines: 8,
    };

    const extent = derivePageExtent(page, page.margin + 61);

    expect(extent.occupiedRows).toBe(2);
    expect(extent.lockedHeight).toBeCloseTo(168.6);
    expect(deriveLegacyLockedHeight(page, page.margin + 61)).toBeCloseTo(1088.6);
  });
});
