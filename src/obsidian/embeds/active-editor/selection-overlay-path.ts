import type { PointV1 } from "../../../domain/schema/public";
import {
  selectionOverlayGeometry,
  type SelectedElementGeometry,
  type SelectionOutline,
  type SelectionPreviewTransform,
} from "../../../editor/selection/public";

const HANDLE_DRAW_RADIUS_PIXELS = 5;

export interface SelectionOverlayPathOptions {
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly transform?: SelectionPreviewTransform | null;
  readonly zoom: number;
}

export function selectionOverlayPath(
  selected: readonly SelectedElementGeometry[],
  options: SelectionOverlayPathOptions,
): string | null {
  const geometry = selectionOverlayGeometry(selected, options.zoom, options.transform ?? null);
  if (geometry === null) return null;
  const parts = [outlinePath(geometry.outline, options.pageToScreen)];
  for (const handle of geometry.handles) {
    parts.push(screenCircle(options.pageToScreen(handle.point)));
  }
  return parts.join(" ");
}

export function selectionOverlayFill(
  selected: readonly SelectedElementGeometry[],
): "accent" | "none" {
  const only = selected.length === 1 ? selected[0]?.element : undefined;
  return only?.kind === "line" || only?.kind === "arrow" ? "none" : "accent";
}

function outlinePath(outline: SelectionOutline, project: (point: PointV1) => PointV1): string {
  if (outline.kind === "linear") {
    const start = project(outline.start);
    const end = project(outline.end);
    if (outline.bend === null) {
      return `M ${String(start.x)} ${String(start.y)} L ${String(end.x)} ${String(end.y)}`;
    }
    const bend = project(outline.bend);
    return `M ${String(start.x)} ${String(start.y)} Q ${String(bend.x)} ${String(bend.y)} ${String(end.x)} ${String(end.y)}`;
  }
  const [first, ...remaining] = outline.points.map(project);
  if (first === undefined) throw new RangeError("A selection polygon needs at least one point.");
  const parts = [`M ${String(first.x)} ${String(first.y)}`];
  for (const point of remaining) parts.push(`L ${String(point.x)} ${String(point.y)}`);
  parts.push("Z");
  return parts.join(" ");
}

function screenCircle(point: PointV1): string {
  const radius = HANDLE_DRAW_RADIUS_PIXELS;
  return `M ${String(point.x - radius)} ${String(point.y)} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
}
