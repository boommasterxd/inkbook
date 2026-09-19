import type { PointV1 } from "../../../domain/schema/public";
import type { SelectionSnapGuide } from "../../../editor/selection/public";

const CONNECTION_SNAP_CROSS_RADIUS_CSS_PIXELS = 12;
const SNAP_GUIDE_EXTENSION_CSS_PIXELS = 24;

export function snapMarkerPath(point: PointV1): string {
  return crossPath(point, CONNECTION_SNAP_CROSS_RADIUS_CSS_PIXELS);
}

function crossPath(point: PointV1, radius: number): string {
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
    const end = pageToScreen(guide.end);
    return [guide.start, ...(guide.additionalStarts ?? [])]
      .map((start) => extendedAxis(pageToScreen(start), end))
      .join(" ");
  }
  if (guide.kind === "separator") {
    const start = pageToScreen(guide.start);
    const end = pageToScreen(guide.end);
    return extendedAxis(start, end);
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
  return indicator;
}

function extendedAxis(start: PointV1, end: PointV1): string {
  return extendedSegmentPath(start, end);
}

function symmetricBendAxis(start: PointV1, end: PointV1, curvePoint: PointV1): string {
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  return extendedSegmentPath(midpoint, curvePoint);
}

function extendedSegmentPath(start: PointV1, end: PointV1): string {
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length === 0) return "";
  const extension = {
    x: (delta.x * SNAP_GUIDE_EXTENSION_CSS_PIXELS) / length,
    y: (delta.y * SNAP_GUIDE_EXTENSION_CSS_PIXELS) / length,
  };
  const from = { x: start.x - extension.x, y: start.y - extension.y };
  const to = { x: end.x + extension.x, y: end.y + extension.y };
  return `M ${String(from.x)} ${String(from.y)} L ${String(to.x)} ${String(to.y)}`;
}
