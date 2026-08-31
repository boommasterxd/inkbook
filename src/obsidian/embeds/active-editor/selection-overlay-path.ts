import {
  rotatePointClockwise,
  tableColumnOffsets,
  tableWidth,
} from "../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import {
  selectionOverlayGeometry,
  transformSelectionPoint,
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

export interface SelectionOverlayPaths {
  readonly handles: string | null;
  readonly outline: string | null;
}

export function selectionOverlayPaths(
  selected: readonly SelectedElementGeometry[],
  options: SelectionOverlayPathOptions,
): SelectionOverlayPaths {
  const geometry = selectionOverlayGeometry(selected, options.zoom, options.transform ?? null);
  if (geometry === null) return { handles: null, outline: null };
  const outlineParts = [outlinePath(geometry.outline, options.pageToScreen)];
  outlineParts.push(...structuralEditPaths(selected, options));
  return {
    handles: geometry.handles
      .map((handle) => screenCircle(options.pageToScreen(handle.point)))
      .join(" "),
    outline: outlineParts.join(" "),
  };
}

export function selectionOverlayPath(
  selected: readonly SelectedElementGeometry[],
  options: SelectionOverlayPathOptions,
): string | null {
  return selectionOverlayPaths(selected, options).outline;
}

function structuralEditPaths(
  selected: readonly SelectedElementGeometry[],
  options: SelectionOverlayPathOptions,
): string[] {
  const element = selected.length === 1 ? selected[0]?.element : undefined;
  if (element === undefined) return [];
  const project = (point: PointV1): PointV1 =>
    options.pageToScreen(
      options.transform === null || options.transform === undefined
        ? point
        : transformSelectionPoint(point, options.transform),
    );
  return structuralEditSegments(element).map(([start, end]) => {
    const projectedStart = project(start);
    const projectedEnd = project(end);
    return `M ${String(projectedStart.x)} ${String(projectedStart.y)} L ${String(projectedEnd.x)} ${String(projectedEnd.y)}`;
  });
}

function structuralEditSegments(element: InkElementV1): Array<readonly [PointV1, PointV1]> {
  if (element.kind === "coordinate-system") {
    const origin = rotatePointClockwise(element.origin, element.pivot, element.rotation);
    return element.axes.map((axis) => [
      origin,
      rotatePointClockwise(axis, element.pivot, element.rotation),
    ]);
  }
  if (element.kind !== "table") return [];
  const rotate = (point: PointV1): PointV1 =>
    rotatePointClockwise(point, element.pivot, element.rotation);
  const horizontal: readonly [PointV1, PointV1] = [
    rotate({ x: element.x, y: element.y + element.headerHeight }),
    rotate({ x: element.x + tableWidth(element), y: element.y + element.headerHeight }),
  ];
  return [
    horizontal,
    ...tableColumnOffsets(element).map((offset): readonly [PointV1, PointV1] => [
      rotate({ x: element.x + offset, y: element.y }),
      rotate({ x: element.x + offset, y: element.y + element.height }),
    ]),
  ];
}

export function selectionOverlayFill(
  selected: readonly SelectedElementGeometry[],
): "accent" | "none" {
  const only = selected.length === 1 ? selected[0]?.element : undefined;
  return only?.kind === "line" || only?.kind === "arrow" || only?.kind === "straight-highlighter"
    ? "none"
    : "accent";
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
