import { pointInPolygon, pointSegmentDistance } from "../../../domain/geometry/public";
import type { BoxAnchorV1, PointV1 } from "../../../domain/schema/public";
import type { PointerSample } from "../../../editor/input/index";
import type { ToolSystemCursor } from "../../../editor/input/tool-cursor";
import type { SelectionHandle, SelectionOutline } from "../../../editor/selection/public";

const SCALE_ANGLES: Readonly<Record<BoxAnchorV1, number>> = {
  "top-left": 45,
  "top-center": 90,
  "top-right": 135,
  "middle-right": 0,
  "bottom-right": 45,
  "bottom-center": 90,
  "bottom-left": 135,
  "middle-left": 0,
};
const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

export function selectionHandleCursor(handle: SelectionHandle, rotation: number): ToolSystemCursor {
  if (handle.kind === "rotate") return "grab";
  if (handle.kind === "table-header") return resizeCursor(90 + rotation);
  if (handle.kind === "table-column") return resizeCursor(rotation);
  if (handle.kind === "scale") return resizeCursor(SCALE_ANGLES[handle.position] + rotation);
  return "move";
}

function resizeCursor(angle: number): ToolSystemCursor {
  const index = ((Math.round(angle / 45) % 4) + 4) % 4;
  return RESIZE_CURSORS[index]!;
}

export function selectionCursorContainsPoint(
  outline: SelectionOutline | null,
  point: PointV1,
): boolean {
  return outline?.kind === "polygon" && pointInPolygon(point, outline.points);
}

export function selectionCursorRadius(
  outline: SelectionOutline | null,
  pointer: PointerSample,
  zoom: number,
): number {
  const base = pointer.pointerType === "touch" ? 24 : pointer.pointerType === "pen" ? 16 : 13;
  const radius = Math.min(28, Math.max(11, base / Math.sqrt(zoom)));
  if (outline?.kind !== "polygon" || !selectionCursorContainsPoint(outline, pointer)) return radius;
  for (let index = 0; index < outline.points.length; index += 1) {
    const start = outline.points[index]!;
    const end = outline.points[(index + 1) % outline.points.length]!;
    if (pointSegmentDistance(pointer, start, end) * zoom <= 10) return radius;
  }
  return Math.min(radius, 10);
}
