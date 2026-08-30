import type { PointV1 } from "../../../domain/schema/public";
import type { SelectionSnapGuide } from "../../../editor/selection/public";

const SNAP_MARKER_RADIUS_PIXELS = 8;
const SNAP_BADGE_OFFSET_PIXELS = 24;
const SNAP_BADGE_RADIUS_PIXELS = 5;

export function snapMarkerPath(point: PointV1): string {
  const radius = SNAP_MARKER_RADIUS_PIXELS;
  const badge = {
    x: point.x + SNAP_BADGE_OFFSET_PIXELS,
    y: point.y - SNAP_BADGE_OFFSET_PIXELS,
  };
  const badgeRadius = SNAP_BADGE_RADIUS_PIXELS;
  return [
    `M ${String(point.x - radius)} ${String(point.y)} L ${String(point.x + radius)} ${String(point.y)}`,
    `M ${String(point.x)} ${String(point.y - radius)} L ${String(point.x)} ${String(point.y + radius)}`,
    `M ${String(point.x + radius * 0.7)} ${String(point.y - radius * 0.7)} L ${String(badge.x - badgeRadius)} ${String(badge.y + badgeRadius)}`,
    `M ${String(badge.x)} ${String(badge.y - badgeRadius)} L ${String(badge.x + badgeRadius)} ${String(badge.y)} L ${String(badge.x)} ${String(badge.y + badgeRadius)} L ${String(badge.x - badgeRadius)} ${String(badge.y)} Z`,
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
    return `M ${String(center.x)} ${String(center.y)} L ${String(handle.x)} ${String(handle.y)} ${snapMarkerPath(handle)}`;
  }
  const start = pageToScreen(guide.start);
  const end = pageToScreen(guide.end);
  const curvePoint = pageToScreen(guide.curvePoint);
  return `M ${String(start.x)} ${String(start.y)} L ${String(end.x)} ${String(end.y)} ${snapMarkerPath(curvePoint)}`;
}
