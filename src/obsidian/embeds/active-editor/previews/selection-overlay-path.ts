import type { PointV1 } from "../../../../domain/schema/public";
import {
  selectionOverlayGeometry,
  type SelectedElementGeometry,
  type OrientedSelectionFrame,
  type SelectionOutline,
  type SelectionOverlayGeometry,
  type SelectionPreviewTransform,
} from "../../../../editor/selection/public";

const HANDLE_DRAW_RADIUS_PIXELS = 5;

export interface SelectionOverlayPathOptions {
  readonly frame?: OrientedSelectionFrame | null;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly transform?: SelectionPreviewTransform | null;
  readonly zoom: number;
}

export interface SelectionOverlayPaths {
  readonly handles: string | null;
  readonly outline: string | null;
}

export function selectionOverlayPaths(
  selected: readonly SelectedElementGeometry[],
  options: SelectionOverlayPathOptions,
  prepared?: SelectionOverlayGeometry | null,
): SelectionOverlayPaths {
  const geometry =
    prepared === undefined
      ? selectionOverlayGeometry(
          selected,
          options.zoom,
          options.transform ?? null,
          options.frame ?? null,
        )
      : prepared;
  if (geometry === null) return { handles: null, outline: null };

  return {
    handles: geometry.handles
      .map((handle) => screenCircle(options.pageToScreen(handle.point)))
      .join(" "),
    outline:
      geometry.outline.kind === "linear"
        ? null
        : outlinePath(geometry.outline, options.pageToScreen),
  };
}

export function selectionOverlayFill(
  selected: readonly SelectedElementGeometry[],
): "accent" | "none" {
  const only = selected.length === 1 ? selected[0]?.element : undefined;
  return only?.kind === "line" || only?.kind === "arrow" || only?.kind === "straight-highlighter"
    ? "none"
    : "accent";
}

function outlinePath(
  outline: Extract<SelectionOutline, { kind: "polygon" }>,
  project: (point: PointV1) => PointV1,
): string {
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
