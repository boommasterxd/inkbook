import type { SceneElementV1 } from "../model";
import type { GeometryProjectionV1, GeometryResultV1 } from "./projection";
import {
  geometryFailureV1,
  geometrySuccessV1,
  isFinitePointV1,
  materializeGeometryPointV1,
} from "./projection";
import type {
  AxisSelectionControlV1,
  AxisSetSelectionModelV1,
} from "./selection-types";

const HALF = 2;

function projectAxis(
  element: SceneElementV1,
  axis: "x" | "y" | "z",
  projection: GeometryProjectionV1,
): GeometryResultV1<AxisSelectionControlV1> {
  if (element.kind !== "axes-2d" && element.kind !== "axes-3d") {
    return geometryFailureV1("target-kind-unsupported");
  }
  let vector = null;
  if (axis === "x") {
    vector = element.geometry.xAxis;
  } else if (axis === "y") {
    vector = element.geometry.yAxis;
  } else if (element.kind === "axes-3d") {
    vector = element.geometry.zAxis;
  }
  if (vector === null) {
    return geometryFailureV1("target-kind-unsupported");
  }
  const start = projection.projectPoint(element, element.geometry.origin);
  const end = projection.projectPoint(element, {
    x: element.geometry.origin.x + vector.x,
    y: element.geometry.origin.y + vector.y,
  });
  if (
    start === null ||
    end === null ||
    !isFinitePointV1(start) ||
    !isFinitePointV1(end)
  ) {
    return geometryFailureV1("projection-invalid");
  }
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const frozenStart = materializeGeometryPointV1(start);
  const frozenEnd = materializeGeometryPointV1(end);
  return geometrySuccessV1(
    Object.freeze({
      axis,
      start: frozenStart,
      end: frozenEnd,
      lengthHandle: frozenEnd,
      controlBound: Object.freeze({
        center: materializeGeometryPointV1({
          x: start.x + deltaX / HALF,
          y: start.y + deltaY / HALF,
        }),
        length: Math.hypot(deltaX, deltaY),
        rotationRadians: Math.atan2(-deltaY, deltaX),
      }),
    }),
  );
}

export function deriveAxisSelectionModelV1(
  element: SceneElementV1,
  projection: GeometryProjectionV1,
): GeometryResultV1<AxisSetSelectionModelV1> {
  if (element.kind !== "axes-2d" && element.kind !== "axes-3d") {
    return geometryFailureV1("target-kind-unsupported");
  }
  const axisNames: readonly ("x" | "y" | "z")[] =
    element.kind === "axes-3d" ? ["x", "y", "z"] : ["x", "y"];
  const axes: AxisSelectionControlV1[] = [];
  for (const axisName of axisNames) {
    const axis = projectAxis(element, axisName, projection);
    if (!axis.ok) {
      return axis;
    }
    axes.push(axis.value);
  }
  const xAxis = axes[0];
  if (xAxis === undefined) {
    return geometryFailureV1("projection-invalid");
  }
  return geometrySuccessV1(
    Object.freeze({
      kind: "axis-set",
      elementId: element.elementId,
      axes: Object.freeze(axes),
      moveTarget: xAxis.start,
      rotateHandle: xAxis.end,
      rotationRadians: Math.atan2(
        -(xAxis.end.y - xAxis.start.y),
        xAxis.end.x - xAxis.start.x,
      ),
      anchorHandle: Object.freeze({
        point: xAxis.start,
        bindingKind: element.binding.kind,
      }),
      geometryTransformAllowed: element.binding.kind !== "text-range",
    }),
  );
}
