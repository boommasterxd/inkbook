import type { Bounds } from "../../../domain/geometry/public";
import type { BoxAnchorV1, InkElementV1, PointV1 } from "../../../domain/schema/public";
import {
  oppositeElementHandlePoint,
  selectionBounds,
  type OrientedSelectionFrame,
  type SelectedElementGeometry,
  type SelectionHandle,
  type SelectionHandleAction,
} from "../../../editor/selection/public";

export function selectionHandleAction(
  handle: SelectionHandle,
  selected: readonly SelectedElementGeometry[],
  frame: OrientedSelectionFrame | null,
): SelectionHandleAction {
  const only = selected.length === 1 ? selected[0]?.element : undefined;
  if (handle.kind === "linear-endpoint" || handle.kind === "linear-bend") {
    if (only === undefined) throw new Error("A linear handle requires one selected element.");
    return handle.kind === "linear-endpoint"
      ? { elementId: only.id, endpoint: handle.endpoint, kind: handle.kind }
      : { elementId: only.id, kind: handle.kind };
  }
  if (handle.kind === "coordinate-axis" || handle.kind === "coordinate-origin") {
    if (only === undefined) throw new Error("A coordinate handle requires one selected element.");
    return handle.kind === "coordinate-axis"
      ? { axisIndex: handle.axisIndex, elementId: only.id, kind: handle.kind }
      : { elementId: only.id, kind: handle.kind };
  }
  if (handle.kind === "table-header" || handle.kind === "table-column") {
    if (only === undefined) throw new Error("A table handle requires one selected element.");
    return handle.kind === "table-column"
      ? {
          elementId: only.id,
          kind: handle.kind,
          separatorIndex: handle.separatorIndex,
        }
      : { elementId: only.id, kind: handle.kind };
  }
  const bounds = selectionBounds(selected);
  if (bounds === null) throw new Error("Selection bounds are unavailable.");
  if (handle.kind === "rotate") return rotationHandleAction(only, bounds, frame);
  return {
    anchor:
      only === undefined
        ? (framePoint(frame, oppositeBoxPosition(handle.position)) ??
          oppositePoint(bounds, handle.position))
        : oppositeElementHandlePoint(only, handle.position),
    kind: handle.kind,
    position: handle.position,
  };
}

function rotationHandleAction(
  element: InkElementV1 | undefined,
  bounds: Bounds,
  frame: OrientedSelectionFrame | null,
): Extract<SelectionHandleAction, { kind: "rotate" }> {
  return {
    center: element?.pivot ?? frameCenter(frame) ?? boundsCenter(bounds),
    kind: "rotate",
    opposite:
      element === undefined
        ? (framePoint(frame, "bottom-center") ?? oppositePoint(bounds, "top-center"))
        : oppositeElementHandlePoint(element, "top-center"),
    referenceRotation: element?.rotation ?? frame?.rotation ?? 0,
  };
}

function frameCenter(frame: OrientedSelectionFrame | null): PointV1 | undefined {
  if (frame === null) return undefined;
  const [topLeft, , bottomRight] = frame.points;
  return { x: (topLeft.x + bottomRight.x) / 2, y: (topLeft.y + bottomRight.y) / 2 };
}

function framePoint(
  frame: OrientedSelectionFrame | null,
  position: BoxAnchorV1,
): PointV1 | undefined {
  if (frame === null) return undefined;
  const [topLeft, topRight, bottomRight, bottomLeft] = frame.points;
  const midpoint = (start: PointV1, end: PointV1) => ({
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  });
  const points: Record<BoxAnchorV1, PointV1> = {
    "bottom-center": midpoint(bottomRight, bottomLeft),
    "bottom-left": bottomLeft,
    "bottom-right": bottomRight,
    "middle-left": midpoint(bottomLeft, topLeft),
    "middle-right": midpoint(topRight, bottomRight),
    "top-center": midpoint(topLeft, topRight),
    "top-left": topLeft,
    "top-right": topRight,
  };
  return points[position];
}

function oppositeBoxPosition(position: BoxAnchorV1): BoxAnchorV1 {
  const opposite: Record<BoxAnchorV1, BoxAnchorV1> = {
    "bottom-center": "top-center",
    "bottom-left": "top-right",
    "bottom-right": "top-left",
    "middle-left": "middle-right",
    "middle-right": "middle-left",
    "top-center": "bottom-center",
    "top-left": "bottom-right",
    "top-right": "bottom-left",
  };
  return opposite[position];
}

function boundsCenter(bounds: Bounds): PointV1 {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function oppositePoint(bounds: Bounds, position: BoxAnchorV1): PointV1 {
  const opposite: Record<BoxAnchorV1, PointV1> = {
    "bottom-center": { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY },
    "bottom-left": { x: bounds.maxX, y: bounds.minY },
    "bottom-right": { x: bounds.minX, y: bounds.minY },
    "middle-left": { x: bounds.maxX, y: (bounds.minY + bounds.maxY) / 2 },
    "middle-right": { x: bounds.minX, y: (bounds.minY + bounds.maxY) / 2 },
    "top-center": { x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY },
    "top-left": { x: bounds.maxX, y: bounds.maxY },
    "top-right": { x: bounds.minX, y: bounds.maxY },
  };
  return opposite[position];
}
