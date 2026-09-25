import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { describe, expect, it } from "vitest";
import { iteratePressureBoundarySimplification } from "../../../../src/domain/geometry/pressure-boundary-simplification";
import { pointSegmentDistance } from "../../../../src/domain/geometry/primitives";
import type { PointV1 } from "../../../../src/domain/schema/types";
import { polygonWinding } from "../../../fixtures/domain/svg-path-fill";

function distanceToChain(point: PointV1, chain: readonly PointV1[]): number {
  let distance = Infinity;
  for (let index = 1; index < chain.length; index += 1) {
    distance = Math.min(distance, pointSegmentDistance(point, chain[index - 1]!, chain[index]!));
  }
  return distance;
}

function expectDeviation(
  source: readonly PointV1[],
  target: readonly PointV1[],
  bound: number,
): void {
  for (let index = 1; index < source.length; index += 1) {
    const first = source[index - 1]!;
    const last = source[index]!;
    for (let step = 0; step <= 20; step += 1) {
      const fraction = step / 20;
      const point = {
        x: first.x + (last.x - first.x) * fraction,
        y: first.y + (last.y - first.y) * fraction,
      };
      expect(distanceToChain(point, target)).toBeLessThanOrEqual(bound + 1e-9);
    }
  }
}

describe("outward pressure boundary simplification", () => {
  it.each([1, -1])(
    "reduces curved boundaries while bounding accumulated error in both directions (%s)",
    (sign) => {
      const points = Array.from({ length: 65 }, (_, index) => ({
        x: index / 8,
        y: (sign * (index / 8) ** 2) / 8,
      }));
      const result = finishGeometrySteps(iteratePressureBoundarySimplification(points, 0.2));
      expect(result.length).toBeLessThan(points.length / 2);
      expect(result[0]).toEqual(points[0]);
      expect(result[result.length - 1]).toEqual(points[points.length - 1]);
      expectDeviation(points, result, 0.2);
      expectDeviation(result, points, 0.2);
    },
  );

  it("adds only negative winding even when the input boundary crosses itself", () => {
    const points = Array.from({ length: 65 }, (_, index) => ({
      x: 8 * Math.sin(index / 7),
      y: 6 * Math.sin(index / 4),
    }));
    const triangles: (readonly PointV1[])[] = [];
    const result = finishGeometrySteps(
      iteratePressureBoundarySimplification(points, 0.4, (triangle) => triangles.push(triangle)),
    );
    expect(triangles.length).toBeGreaterThan(0);
    for (let x = -8.13; x <= 8; x += 0.41) {
      for (let y = -6.23; y <= 6; y += 0.43) {
        const point = { x, y };
        expect(polygonWinding(result, point)).toBeLessThanOrEqual(polygonWinding(points, point));
        expect(polygonWinding(result, point)).toBe(
          polygonWinding(points, point) -
            triangles.reduce((sum, triangle) => sum + Math.abs(polygonWinding(triangle, point)), 0),
        );
      }
    }
    expectDeviation(points, result, 0.4);
    expectDeviation(result, points, 0.4);
  });

  it("retains the original axis box when convex tangent intersections would exceed it", () => {
    const points = [
      { x: -2, y: 0 },
      { x: -1, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
    ];
    const result = finishGeometrySteps(iteratePressureBoundarySimplification(points, 10));
    for (const point of result) {
      expect(point.x).toBeGreaterThanOrEqual(-2);
      expect(point.x).toBeLessThanOrEqual(2);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
    expect(result).toEqual(points);
  });

  it("handles repeated points and straight boundaries without moving endpoints", () => {
    const points = [
      { x: -3, y: -5 },
      { x: -3, y: -5 },
      { x: 0, y: -5 },
      { x: 7, y: -5 },
    ];
    expect(finishGeometrySteps(iteratePressureBoundarySimplification(points, 0))).toEqual([
      points[0],
      points[3],
    ]);
    expect(finishGeometrySteps(iteratePressureBoundarySimplification([], 0))).toEqual([]);
    expect(
      finishGeometrySteps(iteratePressureBoundarySimplification(points.slice(0, 1), 0)),
    ).toEqual(points.slice(0, 1));
    expect(() => finishGeometrySteps(iteratePressureBoundarySimplification(points, -1))).toThrow(
      RangeError,
    );
    expect(() =>
      finishGeometrySteps(iteratePressureBoundarySimplification(points, Infinity)),
    ).toThrow(RangeError);
  });
});
