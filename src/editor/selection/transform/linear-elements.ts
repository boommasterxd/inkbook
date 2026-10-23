import { rotatePointClockwise } from "../../../domain/geometry/public";
import type { InkElementV1, LinearElementV1, PointV1 } from "../../../domain/schema/public";

export function isLinearElement(element: InkElementV1): element is LinearElementV1 {
  return (
    element.kind === "line" || element.kind === "arrow" || element.kind === "straight-highlighter"
  );
}

export function worldLinearEndpoint(element: LinearElementV1, endpoint: "start" | "end"): PointV1 {
  return rotatePointClockwise(element[endpoint], element.pivot, element.rotation);
}
