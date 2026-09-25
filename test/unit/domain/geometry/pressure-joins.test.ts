import { describe, expect, it } from "vitest";
import {
  buildPressureCapsule,
  pressureArcPoint,
  type PressureBoundaryArc,
  type PressureCapsule,
  type PressureCenter,
} from "../../../../src/domain/geometry/pressure-joins";
import type { PointV1 } from "../../../../src/domain/schema/types";
import { polygonWinding as winding } from "../../../fixtures/domain/svg-path-fill";

function capsule(first: PressureCenter, last: PressureCenter, width = 22): PressureCapsule {
  const result = buildPressureCapsule(first, last, width);
  if (result.kind !== "capsule") throw new Error("Expected a non-contained capsule");
  return result;
}

function sampledArc(arc: PressureBoundaryArc, reverse = false): PointV1[] {
  const count = Math.max(1, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 64)));
  return Array.from({ length: count + 1 }, (_, index) =>
    pressureArcPoint(arc, reverse ? 1 - index / count : index / count),
  );
}

function joinedContour(capsules: readonly PressureCapsule[]): PointV1[] {
  return capsules.flatMap((capsule) => [
    capsule.left.start,
    capsule.left.end,
    ...sampledArc(capsule.endCap),
    capsule.right.start,
    ...sampledArc(capsule.startCap),
  ]);
}

describe("pressure disk hulls", () => {
  it("keeps genuine tangent supports and constant width along long straight legs", () => {
    const result = capsule({ x: 0, y: 0, pressure: 1 }, { x: 100, y: 0, pressure: 1 });
    expect(result.left.start.y).toBe(11);
    expect(result.left.end.y).toBe(11);
    expect(result.right.start.y).toBe(-11);
    expect(result.right.end.y).toBe(-11);
    expect(result.startCap.sweep).toBe(-Math.PI);
    expect(result.endCap.sweep).toBe(-Math.PI);
  });

  it("uses unequal cap sweeps for a changing radius and contains both entire nib disks", () => {
    const result = capsule({ x: -10, y: -20, pressure: 0 }, { x: 20, y: -10, pressure: 1 });
    expect(result.startCap.sweep).toBeGreaterThan(-Math.PI);
    expect(result.endCap.sweep).toBeLessThan(-Math.PI);
    const contour = joinedContour([result]);
    for (const nib of [result.start, result.end]) {
      for (let index = 0; index < 32; index += 1) {
        const angle = (index / 32) * 2 * Math.PI;
        expect(
          winding(contour, {
            x: nib.center.x + nib.radius * 0.99 * Math.cos(angle),
            y: nib.center.y + nib.radius * 0.99 * Math.sin(angle),
          }),
        ).toBe(-1);
      }
    }
  });

  it.each([
    [0, 0, 1, 0],
    [1, 1, 0, 0],
    [1, 0, 1, 1],
    [0, 1, 1, 0],
  ])("retains the larger nib for coincident and contained disks", (x, p1, p2, cx) => {
    const result = buildPressureCapsule(
      { x: 0, y: 0, pressure: p1 },
      { x: x, y: 0, pressure: p2 },
      22,
    );
    expect(result).toEqual({ kind: "dot", center: { x: cx, y: 0 }, radius: 11 });
  });
});
