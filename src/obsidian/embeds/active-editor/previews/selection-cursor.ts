import {
  pointInPolygon,
  pointSegmentDistance,
  rotatePointClockwise,
} from "../../../../domain/geometry/public";
import { textContentWidth } from "../../../../domain/geometry/text-padding";
import type {
  BoxAnchorV1,
  InkElementV1,
  PointV1,
  TextElementV2,
} from "../../../../domain/schema/public";
import type { PointerSample } from "../../../../editor/input/index";
import type { ToolSystemCursor } from "../../../../editor/input/tool-cursor";
import type { SelectionHandle, SelectionOutline } from "../../../../editor/selection/public";
import {
  findSelectionHandle,
  type HitTestScratch,
  type SelectionOverlayGeometry,
  type SelectedElementGeometry,
} from "../../../../editor/selection/public";

export function selectionCursorAt(
  geometry: SelectionOverlayGeometry | null,
  pointer: PointerSample,
  options: {
    readonly zoom: number;
    readonly rotation: number;
    readonly linear: InkElementV1 | undefined;
    readonly hit: HitTestScratch;
    readonly selected?: readonly SelectedElementGeometry[];
    readonly handlesOnly?: boolean;
    readonly visualOnly?: boolean;
  },
): ToolSystemCursor | undefined {
  if (geometry === null) return undefined;
  const handle = selectionCursorHandle(
    geometry,
    pointer,
    options.zoom,
    options.selected,
    options.visualOnly,
  );
  if (handle !== null) return selectionHandleCursor(handle, options.rotation);
  if (options.handlesOnly) return undefined;
  if (selectionCursorContainsPoint(geometry.outline, pointer)) return "move";
  if (options.linear === undefined) return undefined;
  options.hit.begin(pointer, pointer.pointerType, options.zoom);
  options.hit.consider(options.linear.id, "content", options.linear, 0);
  return options.hit.finish() === null ? undefined : "move";
}

export function selectionCursorHandle(
  geometry: SelectionOverlayGeometry | null,
  pointer: PointerSample,
  zoom: number,
  selected: readonly SelectedElementGeometry[] = [],
  visualOnly = false,
): SelectionHandle | null {
  const element = selected.length === 1 ? selected[0]?.element : undefined;
  const radius =
    element?.kind === "text" && (visualOnly || textContentContainsPoint(element, pointer))
      ? 6
      : selectionCursorRadius(geometry?.outline ?? null, pointer, zoom);
  return geometry === null ? null : findSelectionHandle(geometry.handles, pointer, zoom, radius);
}

function textContentContainsPoint(element: TextElementV2, point: PointV1): boolean {
  const local = rotatePointClockwise(point, element.pivot, -element.rotation);
  const padding = element.layout.padding ?? 0;
  const left = element.x + padding;
  return (
    local.x >= left &&
    local.x <= left + textContentWidth(element.width, padding) &&
    local.y >= element.y + padding &&
    local.y <= element.y + element.height - padding
  );
}

export function preferredSelectionHandle(
  handles: readonly SelectionHandle[],
  preferred: SelectionHandle,
): SelectionHandle | null {
  return (
    handles.find(
      (candidate) =>
        candidate.kind === preferred.kind &&
        (candidate.kind !== "scale" ||
          (preferred.kind === "scale" && candidate.position === preferred.position)),
    ) ?? null
  );
}

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
