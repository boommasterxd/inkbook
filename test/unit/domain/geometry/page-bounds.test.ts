import { describe, expect, it } from "vitest";

import {
  canonicalPageBoundsCorrection,
  calculateElementBounds,
  correctElementsToPageBounds,
  translateElementGeometry,
} from "../../../../src/domain/geometry/public";
import type { ArrowElementV1 } from "../../../../src/domain/schema/public";

import { outlineStyle, rectangle } from "./fixtures";

describe("page-bound geometry correction", () => {
  it("rounds page-bound translations outward at canonical precision", () => {
    expect(
      canonicalPageBoundsCorrection({ maxX: 100, maxY: 100, minX: -0.000_1, minY: -0.000_1 }),
    ).toEqual({ x: 0.001, y: 0.001 });
    expect(
      canonicalPageBoundsCorrection({ maxX: 2_048.600_1, maxY: 100, minX: 10, minY: 0 }),
    ).toEqual({ x: -0.001, y: 0 });
    expect(canonicalPageBoundsCorrection({ maxX: 2_049, maxY: 100, minX: 0, minY: 0 })).toBeNull();
  });

  it.each([
    ["creation", rectangle({ x: -100, pivot: { x: -50, y: 25 } })],
    ["move", rectangle({ x: 2_000, pivot: { x: 2_050, y: 25 } })],
    ["rotation", rectangle({ rotation: 45 })],
    ["scale", rectangle({ x: -20, width: 200, pivot: { x: 80, y: 25 } })],
    ["handle edit", bentArrow()],
  ])("corrects a %s candidate as one canonical translation", (_operation, candidate) => {
    const result = correctElementsToPageBounds([candidate]);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    const bounds = calculateElementBounds(result.elements[0]!);
    expect(bounds.minX).toBeGreaterThanOrEqual(0);
    expect(bounds.minY).toBeGreaterThanOrEqual(0);
    expect(bounds.maxX).toBeLessThanOrEqual(2_048.6);
    expect(result.correction).not.toEqual({ x: 0, y: 0 });
  });

  it("corrects a multi-element candidate without changing relative geometry", () => {
    const first = rectangle({ x: -20, pivot: { x: 30, y: 25 } });
    const second = rectangle({
      id: "00000000-0000-4000-8000-000000000009",
      x: 180,
      pivot: { x: 230, y: 25 },
    });
    const result = correctElementsToPageBounds([first, second]);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    const [correctedFirst, correctedSecond] = result.elements;
    expect(correctedFirst?.pivot.x).toBe(51);
    expect(correctedSecond?.pivot.x).toBe(251);
  });

  it("rejects candidates whose conservative width cannot fit the page", () => {
    const candidate = rectangle({ width: 2_048, pivot: { x: 1_024, y: 25 } });

    expect(correctElementsToPageBounds([candidate])).toEqual({
      reason: "width-exceeded",
      status: "rejected",
    });
  });

  it("translates every canonical coordinate of a runtime stroke", () => {
    const source = {
      createdAt: 0,
      id: "00000000-0000-4000-8000-000000000010",
      kind: "stroke",
      pivot: { x: 5, y: 5 },
      points: new Float64Array([0, 0, 0.5, 10, 10, 1]),
      rotation: 0,
      style: {
        color: { type: "theme-text" },
        opacity: 1,
        pressureEnabled: true,
        smoothing: 0.5,
        width: 2,
      },
      tool: "pen",
    } as const;

    const translated = translateElementGeometry(source as never, { x: 2, y: 3 });

    expect(translated.kind).toBe("stroke");
    if (translated.kind !== "stroke") return;
    expect(translated.points).toEqual(new Float64Array([2, 3, 0.5, 12, 13, 1]));
    expect(translated.pivot).toEqual({ x: 7, y: 8 });
  });
});

function bentArrow(): ArrowElementV1 {
  return {
    bend: { x: 50, y: -50 },
    createdAt: 0,
    end: { x: 100, y: 20 },
    endConnection: null,
    endNode: "arrow",
    id: "00000000-0000-4000-8000-000000000008",
    kind: "arrow",
    pivot: { x: 50, y: -15 },
    rotation: 0,
    start: { x: 0, y: 20 },
    startConnection: null,
    startNode: "none",
    style: outlineStyle,
  };
}
