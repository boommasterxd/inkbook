import { describe, expect, it } from "vitest";

import { pointSegmentDistance } from "../../../../src/domain/geometry/primitives";
import { transformedStrokeCenters } from "../../../../src/domain/geometry/stroke-path";
import { elementContainsPoint } from "../../../../src/editor/selection/query/hit-test";
import { strokeSvgContainsPoint } from "../../../fixtures/domain/svg-path-fill";
import { stroke } from "../../domain/schema/fixtures";

describe("pressure hit world geometry", () => {
  it("rebuilds world-space bounds when a shared sample array rotates or changes pivot", () => {
    const points = [0, 0, 1, 20, 40, 1, 40, 0, 1];
    Object.freeze(points);
    const base = {
      ...stroke(),
      points,
      pivot: { x: 0, y: 0 },
      style: { ...stroke().style, pressureEnabled: true, width: 8 as const },
    };
    const target = { ...base, rotation: 17 };
    const point = { x: 14.817048422913633, y: 28.687524934410817 };
    const centers = transformedStrokeCenters(target);
    expect(pointSegmentDistance(point, centers[0]!, centers[1]!)).toBeGreaterThan(4);
    expect(pointSegmentDistance(point, centers[1]!, centers[2]!)).toBeGreaterThan(4);
    expect(strokeSvgContainsPoint(target, point)).toBe(true);
    // Prime one bounded cache entry with a different transform of the same samples.
    expect(elementContainsPoint(base, point, 0)).toBe(false);
    expect(elementContainsPoint(target, point, 0)).toBe(true);
    const moved = { ...target, pivot: { x: 200, y: 300 } };
    const movedCenter = transformedStrokeCenters(moved)[1]!;
    const movedPoint = { x: movedCenter.x, y: movedCenter.y };
    expect(elementContainsPoint(moved, point, 0)).toBe(false);
    expect(elementContainsPoint(moved, movedPoint, 0)).toBe(true);
    expect(elementContainsPoint(target, point, 0)).toBe(true);
  });
});
