import { rotatePointClockwise } from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";
import type { SnapCandidate } from "../snapping/snap-candidate";

import { editLinearBendFromCurvePoint } from "./linear-bend";
import { isLinearElement } from "./linear-elements";
import {
  HANDLE_SNAP_PIXELS,
  linearEndpointSnapPoint,
  selectionSnapZoom,
} from "./handle-snap-resolution";
import { canonicalHandlePoint, clampEndpoint } from "./handle-session-geometry";
import { selectionSnapFeatureEnabled } from "./snap-features";
import type { SelectionHandleAction, SelectionSnapPorts } from "./handle-types";
import {
  resolveCoordinateAxisSnap,
  resolveCoordinateOriginSnap,
  resolveTableColumnSnap,
  resolveTableHeaderSnap,
} from "./structural-handle-snap";
import {
  editCoordinateAxis,
  editCoordinateOrigin,
  editLinearEndpointFromWorld,
  editTableColumn,
  editTableHeader,
} from "./transforms";

type TargetedHandleAction = Extract<SelectionHandleAction, { readonly elementId: string }>;

interface TargetedHandleInput {
  readonly action: TargetedHandleAction;
  readonly candidate: SnapCandidate | null;
  readonly element: InkElementV1;
  readonly pointer: PointV1;
  readonly snap: SelectionSnapPorts | undefined;
}

export function materializeTargetedHandle(input: TargetedHandleInput): InkElementV1 {
  if (input.action.kind === "linear-endpoint") return editLinearHandleEndpoint(input);
  if (input.action.kind === "linear-bend") {
    return editLinearBendFromCurvePoint(
      input.element,
      input.pointer,
      selectionSnapFeatureEnabled(input.snap, "bends")
        ? HANDLE_SNAP_PIXELS / selectionSnapZoom(input.snap)
        : 0,
    );
  }
  if (input.action.kind === "table-header" || input.action.kind === "table-column") {
    return editTableHandle(input);
  }
  return editCoordinateHandle(input);
}

function editLinearHandleEndpoint(input: TargetedHandleInput): InkElementV1 {
  const { action, candidate, element, pointer, snap } = input;
  if (action.kind !== "linear-endpoint") throw new Error("Expected a linear endpoint action.");
  if (!isLinearElement(element)) {
    throw new TypeError("Endpoint handles require a linear drawing element.");
  }
  const oppositeLocal = action.endpoint === "start" ? element.end : element.start;
  const opposite = rotatePointClockwise(oppositeLocal, element.pivot, element.rotation);
  const point = clampEndpoint(
    linearEndpointSnapPoint(element, action.endpoint, pointer, candidate, snap),
    opposite,
  );
  const connection =
    candidate === null || element.kind === "straight-highlighter"
      ? null
      : { anchor: candidate.anchor, targetId: candidate.targetId };
  return editLinearEndpointFromWorld(element, action.endpoint, point, {
    connection,
    straightTolerance: selectionSnapFeatureEnabled(snap, "angles")
      ? HANDLE_SNAP_PIXELS / selectionSnapZoom(snap)
      : 0,
  });
}

function editTableHandle(input: TargetedHandleInput): InkElementV1 {
  const { action, element, pointer, snap } = input;
  if (element.kind !== "table") throw new TypeError("Table handles require a table.");
  if (action.kind !== "table-header" && action.kind !== "table-column") {
    throw new Error("Expected a table handle action.");
  }
  const localPointer = canonicalHandlePoint(element, pointer);
  if (!selectionSnapFeatureEnabled(snap, "structures")) {
    return action.kind === "table-header"
      ? editTableHeader(element, localPointer.y)
      : editTableColumn(element, action.separatorIndex, localPointer.x);
  }
  const tolerance = HANDLE_SNAP_PIXELS / selectionSnapZoom(snap);
  if (action.kind === "table-header") {
    return editTableHeader(
      element,
      resolveTableHeaderSnap(element, localPointer, tolerance).point.y,
    );
  }
  const point = resolveTableColumnSnap(
    element,
    action.separatorIndex,
    localPointer,
    tolerance,
  ).point;
  return editTableColumn(element, action.separatorIndex, point.x);
}

function editCoordinateHandle(input: TargetedHandleInput): InkElementV1 {
  const { action, element, pointer, snap } = input;
  if (element.kind !== "coordinate-system") {
    throw new TypeError("Coordinate handles require a coordinate system.");
  }
  if (!selectionSnapFeatureEnabled(snap, "angles")) {
    return action.kind === "coordinate-axis"
      ? editCoordinateAxis(element, action.axisIndex, canonicalHandlePoint(element, pointer))
      : editCoordinateOrigin(element, pointer);
  }
  const worldPoint =
    action.kind === "coordinate-axis"
      ? resolveCoordinateAxisSnap(element, pointer, HANDLE_SNAP_PIXELS, selectionSnapZoom(snap))
          .point
      : resolveCoordinateOriginSnap(element, pointer, HANDLE_SNAP_PIXELS, selectionSnapZoom(snap))
          .point;
  return action.kind === "coordinate-axis"
    ? editCoordinateAxis(element, action.axisIndex, canonicalHandlePoint(element, worldPoint))
    : editCoordinateOrigin(element, worldPoint);
}
