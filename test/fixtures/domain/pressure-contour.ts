import {
  pressureBoundaryPoint,
  type PressureBoundarySegment,
} from "../../../src/domain/geometry/pressure/pressure-boundary-intersections";

/** Sample directed analytic edges for independent nonzero-fill assertions. */
export function samplePressureContour(contour: readonly PressureBoundarySegment[]) {
  return contour.flatMap((edge) => {
    const count = edge.kind === "line" ? 1 : Math.ceil(Math.abs(edge.sweep) / (Math.PI / 512));
    return Array.from({ length: count }, (_, index) => pressureBoundaryPoint(edge, index / count));
  });
}
