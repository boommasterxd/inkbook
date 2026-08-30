import type { PointV1 } from "../../../domain/schema/public";

const SNAP_MARKER_RADIUS_PIXELS = 7.5;

export function snapMarkerPath(point: PointV1): string {
  const radius = SNAP_MARKER_RADIUS_PIXELS;
  return `M ${String(point.x - radius)} ${String(point.y)} L ${String(point.x + radius)} ${String(point.y)} M ${String(point.x)} ${String(point.y - radius)} L ${String(point.x)} ${String(point.y + radius)}`;
}
