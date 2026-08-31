import type { PointV1 } from "../../../domain/schema/public";
import type { SelectionSnapGuide } from "../../../editor/selection/public";

const SNAP_MARKER_RADIUS_PIXELS = 8;

export function snapMarkerPath(point: PointV1): string {
  const radius = SNAP_MARKER_RADIUS_PIXELS;
  return [
    `M ${String(point.x - radius)} ${String(point.y)} L ${String(point.x + radius)} ${String(point.y)}`,
    `M ${String(point.x)} ${String(point.y - radius)} L ${String(point.x)} ${String(point.y + radius)}`,
  ].join(" ");
}

export function selectionSnapGuidePath(
  guide: SelectionSnapGuide,
  pageToScreen: (point: PointV1) => PointV1,
): string {
  if (guide.kind === "anchor") return snapMarkerPath(pageToScreen(guide.point));
  if (guide.kind === "rotation") {
    const center = pageToScreen(guide.center);
    const handle = pageToScreen(guide.handle);
    const opposite = {
      x: center.x * 2 - handle.x,
      y: center.y * 2 - handle.y,
    };
    return `M ${String(opposite.x)} ${String(opposite.y)} L ${String(handle.x)} ${String(handle.y)}`;
  }
  const start = pageToScreen(guide.start);
  const end = pageToScreen(guide.end);
  const curvePoint = pageToScreen(guide.curvePoint);
  const indicator =
    guide.alignment === "straight"
      ? `M ${String(start.x)} ${String(start.y)} L ${String(end.x)} ${String(end.y)}`
      : symmetricBendAxis(start, end, curvePoint);
  return `${indicator} ${snapMarkerPath(curvePoint)}`;
}

function symmetricBendAxis(start: PointV1, end: PointV1, curvePoint: PointV1): string {
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const delta = { x: curvePoint.x - midpoint.x, y: curvePoint.y - midpoint.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length === 0) return snapMarkerPath(curvePoint);
  const extension = {
    x: (delta.x * SNAP_MARKER_RADIUS_PIXELS) / length,
    y: (delta.y * SNAP_MARKER_RADIUS_PIXELS) / length,
  };
  const from = { x: midpoint.x - extension.x, y: midpoint.y - extension.y };
  const to = { x: curvePoint.x + extension.x, y: curvePoint.y + extension.y };
  return `M ${String(from.x)} ${String(from.y)} L ${String(to.x)} ${String(to.y)}`;
}
