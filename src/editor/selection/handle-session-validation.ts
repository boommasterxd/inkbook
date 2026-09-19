import type { PointV1 } from "../../domain/schema/public";

export function assertFiniteHandlePoint(point: PointV1): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("Handle points must be finite.");
  }
}
