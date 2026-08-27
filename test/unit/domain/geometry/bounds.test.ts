import type { ArrowElementV1, PageV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { describe, expect, it } from "vitest";

import {
  alignPageHeightToWritingLine,
  boundsIntersect,
  calculateElementBounds,
  derivePageExtent,
  effectiveStrokeWidth,
} from "../../../../src/domain/geometry/public";
import { EVERY_BACKGROUND } from "../../../fixtures/backgrounds";
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
  it("aligns transient scene envelopes to writing lines without depending on the background", () => {
    const page: PageV1 = {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "squares", spacing: 50 },
      activeBufferLines: 1,
      lockedBufferLines: 0,
    };

    expect(alignPageHeightToWritingLine(page, 333.2)).toBe(348.6);
    expect(alignPageHeightToWritingLine(page, 348.6)).toBe(348.6);
    expect(alignPageHeightToWritingLine({ ...page, background: { type: "none" } }, 333.2)).toBe(
      348.6,
    );
  });

  it("derives active and locked heights on background-independent writing rows", () => {
    const page: PageV1 = {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "lines", spacing: 50 },
      activeBufferLines: 3,
      lockedBufferLines: 1,
    };
    const emptyExtent = derivePageExtent(page, null);
    expect(emptyExtent).toMatchObject({
      layoutStep: 100,
      bufferUnit: 100,
      occupiedRows: 0,
      activeHeight: 348.6,
    });
    expect(emptyExtent.lockedHeight).toBeCloseTo(348.6);
    expect(derivePageExtent(page, calculateElementBounds(table()).maxY).occupiedRows).toBe(1);
  });

  it("keeps an empty page at least two and a half writing lines tall", () => {
    const page: PageV1 = {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "squares", spacing: 50 },
      activeBufferLines: 1,
      lockedBufferLines: 0,
    };

    expect(derivePageExtent(page, null)).toMatchObject({
      activeHeight: 348.6,
      lockedHeight: 348.6,
    });
    expect(derivePageExtent(page, page.margin + 40).lockedHeight).toBe(248.6);
  });

  it("keeps exactly one complete writing row after occupied content when locked", () => {
    const page: PageV1 = {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "squares", spacing: 50 },
      activeBufferLines: 3,
      lockedBufferLines: 8,
    };

    const extent = derivePageExtent(page, page.margin + 61);

    expect(extent.occupiedRows).toBe(1);
    expect(extent.lockedHeight).toBeCloseTo(248.6);
  });

  it("keeps both page heights invariant across every background type and spacing", () => {
    const extents = EVERY_BACKGROUND.map((background) =>
      derivePageExtent(
        {
          activeBufferLines: 3,
          background,
          innerWidth: 2_000,
          lockedBufferLines: 1,
          margin: 24.3,
        },
        361,
      ),
    );

    expect(new Set(extents.map(({ activeHeight }) => activeHeight))).toEqual(new Set([748.6]));
    expect(new Set(extents.map(({ lockedHeight }) => lockedHeight))).toEqual(new Set([548.6]));
  });
});
