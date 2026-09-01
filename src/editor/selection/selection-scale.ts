import { rotatePointClockwise } from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";

import { activeScaleAxes } from "./handle-session-geometry";
import { scaleFactorsFromPointers, uniformScaleFactorsFromPointers } from "./transforms";
import type { SelectionHandleAction } from "./handle-types";

export function selectionScaleFactors(
  element: InkElementV1,
  action: Extract<SelectionHandleAction, { kind: "scale" }>,
  startPointer: PointV1,
  currentPointer: PointV1,
  uniform: boolean,
) {
  const axes = activeScaleAxes(action.position);
  if (!uniform)
    return scaleFactorsFromPointers(element, action.anchor, startPointer, currentPointer, axes);
  return uniformScaleFactorsFromPointers(
    element,
    rotatePointClockwise(action.anchor, element.pivot, -element.rotation),
    rotatePointClockwise(startPointer, element.pivot, -element.rotation),
    rotatePointClockwise(currentPointer, element.pivot, -element.rotation),
    axes,
  );
}
