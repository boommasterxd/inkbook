import type { InkElementV1, PointV1 } from "../../domain/schema/public";

export function assertFiniteHandlePoint(point: PointV1): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("Handle points must be finite.");
  }
}

export function assertLinearHandleElement(
  element: InkElementV1,
): Extract<InkElementV1, { kind: "arrow" | "line" | "straight-highlighter" }> {
  if (
    element.kind !== "line" &&
    element.kind !== "arrow" &&
    element.kind !== "straight-highlighter"
  ) {
    throw new TypeError("Endpoint handles require a linear drawing element.");
  }
  return element;
}
