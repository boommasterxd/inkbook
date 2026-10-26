import type { Bounds } from "../../../../domain/geometry/public";
import type { BoxAnchorV1, InkElementV1, PointV1 } from "../../../../domain/schema/public";
import {
  oppositeElementHandlePoint,
  oppositeBoxAnchor,
  selectionFramePoint,
  selectionBounds,
  type OrientedSelectionFrame,
  type SelectedElementGeometry,
  type SelectionHandle,
  type SelectionHandleAction,
} from "../../../../editor/selection/public";

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
  if (selected.length > 1 && frame !== null) return framedHandleAction(handle, frame);
  const bounds = selectionBounds(selected);
  if (bounds === null) throw new Error("Selection bounds are unavailable.");
  if (handle.kind === "rotate") return rotationHandleAction(only, bounds, frame);
  return scaleHandleAction(handle, only, bounds, frame);
}

function framedHandleAction(
  handle: Extract<SelectionHandle, { kind: "scale" | "rotate" }>,
  frame: OrientedSelectionFrame,
): SelectionHandleAction {
  const opposite = selectionFramePoint(
    frame,
    oppositeBoxAnchor(handle.kind === "rotate" ? "top-center" : handle.position),
  );
  return handle.kind === "rotate"
    ? {
        center: frameCenter(frame)!,
        kind: "rotate",
        opposite,
        referenceRotation: frame.rotation,
      }
    : {
        anchor: opposite,
        kind: "scale",
        position: handle.position,
        rotation: frame.rotation,
      };
}

function scaleHandleAction(
  handle: Extract<SelectionHandle, { kind: "scale" }>,
  element: InkElementV1 | undefined,
  bounds: Bounds,
  frame: OrientedSelectionFrame | null,
): Extract<SelectionHandleAction, { kind: "scale" }> {
  return {
    anchor: oppositeHandlePoint(element, bounds, frame, handle.position),
    kind: handle.kind,
    position: handle.position,
    rotation: element?.rotation ?? frame?.rotation ?? 0,
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
    opposite: oppositeHandlePoint(element, bounds, frame, "top-center"),
    referenceRotation: element?.rotation ?? frame?.rotation ?? 0,
  };
}

function oppositeHandlePoint(
  element: InkElementV1 | undefined,
  bounds: Bounds,
  frame: OrientedSelectionFrame | null,
  position: BoxAnchorV1,
): PointV1 {
  if (element !== undefined && (element.kind !== "stroke" || frame === null))
    return oppositeElementHandlePoint(element, position);
  return frame === null
    ? oppositePoint(bounds, position)
    : selectionFramePoint(frame, oppositeBoxAnchor(position));
}

function frameCenter(frame: OrientedSelectionFrame | null): PointV1 | undefined {
  if (frame === null) return undefined;
  const [topLeft, , bottomRight] = frame.points;
  return { x: (topLeft.x + bottomRight.x) / 2, y: (topLeft.y + bottomRight.y) / 2 };
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
