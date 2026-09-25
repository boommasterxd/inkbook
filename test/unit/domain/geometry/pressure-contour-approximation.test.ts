import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { describe, expect, it } from "vitest";
import { buildPressureCapsule } from "../../../../src/domain/geometry/pressure-joins";
import { iteratePressureUnion } from "../../../../src/domain/geometry/pressure-union";
import { iteratePressureContourApproximation } from "../../../../src/domain/geometry/pressure-contour-approximation";
import { serializePressureWindows } from "../../../../src/domain/geometry/pressure-path-serialization";
import { pressureCapsuleContains } from "../../../../src/domain/geometry/pressure-capsule-containment";
import { pointSegmentDistance } from "../../../../src/domain/geometry/primitives";
import type { PointV1 } from "../../../../src/domain/schema/types";
import { polygonWinding, sampleSvgPathContours } from "../../../fixtures/domain/svg-path-fill";

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
