import {
  calculateElementBounds,
  rotatePointClockwise,
  unionBounds,
  type Bounds,
} from "../../domain/geometry/public";
import type { BoxAnchorV1, InkElementV1, PointV1 } from "../../domain/schema/public";

const BOX_HANDLE_ORDER: readonly BoxAnchorV1[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-right",
  "bottom-right",
  "bottom-center",
  "bottom-left",
  "middle-left",
];

export type SelectionHandle =
  | { readonly kind: "scale"; readonly point: PointV1; readonly position: BoxAnchorV1 }
  | { readonly kind: "shape-resize"; readonly point: PointV1; readonly position: BoxAnchorV1 }
  | { readonly kind: "rotate"; readonly point: PointV1 }
  | {
      readonly endpoint: "start" | "end";
      readonly kind: "linear-endpoint";
      readonly point: PointV1;
    }
  | { readonly kind: "linear-bend"; readonly point: PointV1 }
  | { readonly kind: "coordinate-origin"; readonly point: PointV1 }
  | { readonly axisIndex: number; readonly kind: "coordinate-axis"; readonly point: PointV1 };

export interface SelectedElementGeometry {
  readonly bounds: Bounds;
  readonly element: InkElementV1;
}

export interface SelectionHandleLayoutOptions {
  readonly rotateOffsetPixels?: number;
  readonly zoom: number;
}

export function selectionBounds(elements: readonly SelectedElementGeometry[]): Bounds | null {
  let bounds: Bounds | null = null;
  for (const selected of elements) {
    bounds = bounds === null ? { ...selected.bounds } : unionBounds(bounds, selected.bounds);
  }
  return bounds;
}

export function oppositeElementHandlePoint(element: InkElementV1, position: BoxAnchorV1): PointV1 {
  const bounds = calculateElementBounds({ ...element, rotation: 0 });
  const point = boxPosition(bounds, oppositeBoxPosition(position));
  return rotatePointClockwise(point, element.pivot, element.rotation);
}

export function layoutSelectionHandles(
  selected: readonly SelectedElementGeometry[],
  options: SelectionHandleLayoutOptions,
): readonly SelectionHandle[] {
  assertPositiveZoom(options.zoom);
  if (selected.length === 0) return [];
  if (selected.length > 1) return multiSelectionHandles(selected, options);
  const item = selected[0]!;
  return singleElementHandles(item.element, options);
}

export function findSelectionHandle(
  handles: readonly SelectionHandle[],
  pointer: PointV1,
  zoom: number,
  radiusPixels: number,
): SelectionHandle | null {
  assertPositiveZoom(zoom);
  if (!Number.isFinite(radiusPixels) || radiusPixels < 0) {
    throw new RangeError("Handle radius must be a non-negative finite number.");
  }
  let best: SelectionHandle | null = null;
  let bestDistance = Infinity;
  for (const handle of handles) {
    const distance = Math.hypot(pointer.x - handle.point.x, pointer.y - handle.point.y) * zoom;
    if (distance <= radiusPixels && distance < bestDistance) {
      best = handle;
      bestDistance = distance;
    }
  }
  return best;
}

function multiSelectionHandles(
  selected: readonly SelectedElementGeometry[],
  options: SelectionHandleLayoutOptions,
): SelectionHandle[] {
  const bounds = selectionBounds(selected);
  if (bounds === null) return [];
  return [
    ...boxHandles(bounds, "scale"),
    rotateHandle(bounds, options.zoom, options.rotateOffsetPixels),
  ];
}

function singleElementHandles(
  element: InkElementV1,
  options: SelectionHandleLayoutOptions,
): SelectionHandle[] {
  if (element.kind === "line" || element.kind === "arrow") {
    return linearHandles(element);
  }
  const bounds = calculateElementBounds({ ...element, rotation: 0 });
  const points = boxHandles(
    bounds,
    element.kind === "rectangle" || element.kind === "ellipse" ? "shape-resize" : "scale",
  ).map((handle) => ({
    ...handle,
    point: rotatePointClockwise(handle.point, element.pivot, element.rotation),
  }));
  const handles: SelectionHandle[] = [
    ...points,
    rotateHandle(bounds, options.zoom, options.rotateOffsetPixels, element),
  ];
  if (element.kind === "coordinate-system") {
    handles.push({
      kind: "coordinate-origin",
      point: rotatePointClockwise(element.origin, element.pivot, element.rotation),
    });
    element.axes.forEach((axis, axisIndex) => {
      handles.push({
        axisIndex,
        kind: "coordinate-axis",
        point: rotatePointClockwise(axis, element.pivot, element.rotation),
      });
    });
  }
  return handles;
}

function linearHandles(
  element: Extract<InkElementV1, { kind: "line" | "arrow" }>,
): SelectionHandle[] {
  const rotate = (point: PointV1) => rotatePointClockwise(point, element.pivot, element.rotation);
  const handles: SelectionHandle[] = [
    { endpoint: "start", kind: "linear-endpoint", point: rotate(element.start) },
    { endpoint: "end", kind: "linear-endpoint", point: rotate(element.end) },
  ];
  const bend = element.bend ?? {
    x: (element.start.x + element.end.x) / 2,
    y: (element.start.y + element.end.y) / 2,
  };
  handles.push({ kind: "linear-bend", point: rotate(bend) });
  return handles;
}

function boxHandles(
  bounds: Bounds,
  kind: "scale" | "shape-resize",
): Array<Extract<SelectionHandle, { kind: "scale" | "shape-resize" }>> {
  return BOX_HANDLE_ORDER.map((position) => ({
    kind,
    point: boxPosition(bounds, position),
    position,
  }));
}

function boxPosition(bounds: Bounds, position: BoxAnchorV1): PointV1 {
  const x = position.includes("left")
    ? bounds.minX
    : position.includes("right")
      ? bounds.maxX
      : (bounds.minX + bounds.maxX) / 2;
  const y = position.startsWith("top")
    ? bounds.minY
    : position.startsWith("bottom")
      ? bounds.maxY
      : (bounds.minY + bounds.maxY) / 2;
  return { x, y };
}

function oppositeBoxPosition(position: BoxAnchorV1): BoxAnchorV1 {
  const opposite: Record<BoxAnchorV1, BoxAnchorV1> = {
    "top-left": "bottom-right",
    "top-center": "bottom-center",
    "top-right": "bottom-left",
    "middle-right": "middle-left",
    "bottom-right": "top-left",
    "bottom-center": "top-center",
    "bottom-left": "top-right",
    "middle-left": "middle-right",
  };
  return opposite[position];
}

function rotateHandle(
  bounds: Bounds,
  zoom: number,
  offsetPixels = 28,
  element?: Pick<InkElementV1, "pivot" | "rotation">,
): Extract<SelectionHandle, { kind: "rotate" }> {
  if (!Number.isFinite(offsetPixels) || offsetPixels < 0) {
    throw new RangeError("Rotation-handle offset must be a non-negative finite number.");
  }
  const point = { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY - offsetPixels / zoom };
  return {
    kind: "rotate",
    point:
      element === undefined ? point : rotatePointClockwise(point, element.pivot, element.rotation),
  };
}

function assertPositiveZoom(zoom: number): void {
  if (!Number.isFinite(zoom) || zoom <= 0)
    throw new RangeError("Zoom must be positive and finite.");
}
