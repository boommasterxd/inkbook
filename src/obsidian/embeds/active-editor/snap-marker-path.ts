import type { PointV1 } from "../../../domain/schema/public";
import type { SelectionSnapGuide } from "../../../editor/selection/public";

const SNAP_MARKER_RADIUS_PIXELS = 8;
const SNAP_LINE_EXTENSION_PIXELS = 64;

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
  if (guide.kind === "angular") {
    return extendedAxis(pageToScreen(guide.start), pageToScreen(guide.end));
  }
  if (guide.kind === "separator") {
    const start = pageToScreen(guide.start);
    const end = pageToScreen(guide.end);
    const handle = pageToScreen(guide.handle);
    return `${extendedAxis(start, end)} ${snapMarkerPath(handle)}`;
  }
  if (guide.kind === "rotation") {
    const handle = pageToScreen(guide.handle);
    const opposite = pageToScreen(guide.opposite);
    return extendedAxis(opposite, handle);
  }
  const start = pageToScreen(guide.start);
  const end = pageToScreen(guide.end);
  const curvePoint = pageToScreen(guide.curvePoint);
  const indicator =
    guide.alignment === "straight"
      ? extendedAxis(start, end)
      : symmetricBendAxis(start, end, curvePoint);
  return `${indicator} ${snapMarkerPath(curvePoint)}`;
}

function extendedAxis(start: PointV1, end: PointV1): string {
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length === 0) return "";
  const extension = {
    x: (delta.x * SNAP_LINE_EXTENSION_PIXELS) / length,
    y: (delta.y * SNAP_LINE_EXTENSION_PIXELS) / length,
  };
  return `M ${String(start.x - extension.x)} ${String(start.y - extension.y)} L ${String(end.x + extension.x)} ${String(end.y + extension.y)}`;
}

function symmetricBendAxis(start: PointV1, end: PointV1, curvePoint: PointV1): string {
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const delta = { x: curvePoint.x - midpoint.x, y: curvePoint.y - midpoint.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length === 0) return snapMarkerPath(curvePoint);
  const extension = {
    x: (delta.x * SNAP_LINE_EXTENSION_PIXELS) / length,
    y: (delta.y * SNAP_LINE_EXTENSION_PIXELS) / length,
  };
  const from = { x: midpoint.x - extension.x, y: midpoint.y - extension.y };
  const to = { x: curvePoint.x + extension.x, y: curvePoint.y + extension.y };
  return `M ${String(from.x)} ${String(from.y)} L ${String(to.x)} ${String(to.y)}`;
}
