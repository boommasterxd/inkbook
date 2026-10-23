import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";
import { describe, expect, it } from "vitest";
import { buildPressureCapsule } from "../../../../../src/domain/geometry/pressure/pressure-joins";
import { iteratePressureUnion } from "../../../../../src/domain/geometry/pressure/pressure-union";
import { iteratePressureContourApproximation } from "../../../../../src/domain/geometry/pressure/pressure-contour-approximation";
import { serializePressureWindows } from "../../../../../src/domain/geometry/pressure/pressure-path-serialization";
import { pressureCapsuleContains } from "../../../../../src/domain/geometry/pressure/pressure-capsule-containment";
import { pointSegmentDistance } from "../../../../../src/domain/geometry/primitives";
import type { PointV1 } from "../../../../../src/domain/schema/types";
import { polygonWinding, sampleSvgPathContours } from "../../../../fixtures/domain/svg-path-fill";

describe("serialized union approximation", () => {
  it.each([2, 8, 22])(
    "matches capsule plus addition triangles and preserves a hole at width %s",
    (width) => {
      const centers = [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
        [0, 0],
      ].map(([x, y]) => ({ x: x!, y: y!, pressure: 1 }));
      const shapes = centers
        .slice(1)
        .map((end, index) => buildPressureCapsule(centers[index]!, end, width));
      const union = finishGeometrySteps(iteratePressureUnion(shapes));
      const additions: (readonly PointV1[])[] = [];
      const loops = union.contours.map((loop) =>
        finishGeometrySteps(iteratePressureContourApproximation(loop, width, additions)),
      );
      const decoded = sampleSvgPathContours(
        serializePressureWindows([{ kind: "window", loops, additions }]),
      );
      const filled = (point: PointV1): boolean =>
        decoded.reduce((sum, contour) => sum + polygonWinding(contour, point), 0) !== 0;
      expect(filled({ x: 20, y: 20 })).toBe(false);
      for (let x = -13.173; x < 54; x += 0.617) {
        for (let y = -13.319; y < 54; y += 0.631) {
          const point = { x, y };
          // Only final thousandth-coordinate rounding is excluded; all contours here are polylines.
          if (
            loops.some((loop) =>
              loop.some((edge) => pointSegmentDistance(point, edge.start, edge.end) <= 0.001),
            )
          )
            continue;
          const expected =
            shapes.some((shape) =>
              shape.kind === "capsule"
                ? pressureCapsuleContains(shape, point)
                : Math.hypot(x - shape.center.x, y - shape.center.y) < shape.radius,
            ) || additions.some((triangle) => polygonWinding(triangle, point) !== 0);
          expect(filled(point)).toBe(expected);
        }
      }
    },
  );
});

describe("count-only outward additions", () => {
  it.each([0.001, 2, 8, 22])("retains exact contours and addition counts at width %s", (width) => {
    const shapes = [
      buildPressureCapsule({ x: 0, y: 0, pressure: 0.2 }, { x: 40, y: 0, pressure: 1 }, width),
      buildPressureCapsule({ x: 40, y: 0, pressure: 1 }, { x: 40, y: 40, pressure: 0.6 }, width),
    ];
    const union = finishGeometrySteps(iteratePressureUnion(shapes));
    const additions: (readonly PointV1[])[] = [];
    const count = { count: 0 };
    for (const loop of union.contours) {
      const full = finishGeometrySteps(iteratePressureContourApproximation(loop, width, additions));
      const path = finishGeometrySteps(iteratePressureContourApproximation(loop, width, count));
      expect(path).toEqual(full);
    }
    expect(count.count).toBe(additions.length);
  });

  it("discards staged arc additions when expansion exceeds 4096 points", () => {
    const arc = {
      kind: "arc" as const,
      start: { x: 100_000_000, y: 0 },
      end: { x: 100_000_000, y: 0 },
      center: { x: 0, y: 0 },
      radius: 100_000_000,
      sweep: -2 * Math.PI,
    };
    const additions: (readonly PointV1[])[] = [];
    const count = { count: 7 };
    expect(finishGeometrySteps(iteratePressureContourApproximation([arc], 2, additions))).toEqual([
      arc,
    ]);
    expect(finishGeometrySteps(iteratePressureContourApproximation([arc], 2, count))).toEqual([
      arc,
    ]);
    expect(additions).toEqual([]);
    expect(count.count).toBe(7);
  });
});
