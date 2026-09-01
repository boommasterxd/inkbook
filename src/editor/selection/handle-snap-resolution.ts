import { rotatePointClockwise } from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";
import type { SnapCandidate } from "../snapping/snap-candidate";

import type { SelectionHandleAction, SelectionSnapGuide, SelectionSnapPorts } from "./handle-types";
import { resolvePointAngleSnap } from "./angular-snap";
import { linearBendSnapGuide } from "./linear-bend";
import { isLinearElement, worldLinearEndpoint } from "./linear-elements";
import { clampEndpoint } from "./handle-session-geometry";
import { editLinearEndpointFromWorld } from "./linear-transforms";
import { resolveRotationSnap } from "./rotation-snap";
import { selectionSnapFeatureEnabled } from "./snap-features";
import {
  resolveCoordinateAxisSnap,
  resolveCoordinateOriginSnap,
  resolveTableColumnSnap,
  resolveTableHeaderSnap,
} from "./structural-handle-snap";

export const HANDLE_SNAP_PIXELS = 5;

interface TargetedGuideContext {
  readonly currentPointer: PointV1;
  readonly elements: readonly InkElementV1[];
  readonly snap: SelectionSnapPorts | undefined;
}

export function selectionRotationDelta(
  action: SelectionHandleAction,
  _elements: readonly InkElementV1[],
  startPointer: PointV1,
  currentPointer: PointV1,
  snap: SelectionSnapPorts | undefined,
): number {
  if (action.kind !== "rotate") throw new Error("Expected a rotate action.");
  return resolveRotationSnap({
    center: action.center,
    currentPointer,
    referenceRotation: action.referenceRotation,
    snapPixels: HANDLE_SNAP_PIXELS,
    startPointer,
    zoom: selectionSnapZoom(snap),
    enabled: selectionSnapFeatureEnabled(snap, "angles"),
  }).delta;
}

export function selectionHandleSnapGuide(
  action: SelectionHandleAction,
  elements: readonly InkElementV1[],
  startPointer: PointV1,
  currentPointer: PointV1,
  candidate: SnapCandidate | null,
  snap: SelectionSnapPorts | undefined,
): SelectionSnapGuide | null {
  const context = { currentPointer, elements, snap };
  if (action.kind === "linear-endpoint") return linearEndpointGuide(action, context, candidate);
  if (action.kind === "rotate") return rotationGuide(action, startPointer, currentPointer, snap);
  if (action.kind === "coordinate-axis" || action.kind === "coordinate-origin") {
    return selectionSnapFeatureEnabled(snap, "angles")
      ? coordinateSnapGuide(action, context)
      : null;
  }
  if (action.kind === "table-header" || action.kind === "table-column") {
    return selectionSnapFeatureEnabled(snap, "structures") ? tableSnapGuide(action, context) : null;
  }
  return action.kind === "linear-bend" && selectionSnapFeatureEnabled(snap, "bends")
    ? bendSnapGuide(action, context)
    : null;
}

function linearEndpointGuide(
  action: Extract<SelectionHandleAction, { kind: "linear-endpoint" }>,
  context: TargetedGuideContext,
  candidate: SnapCandidate | null,
): SelectionSnapGuide | null {
  if (candidate !== null) return { kind: "anchor", point: candidate.point };
  if (!selectionSnapFeatureEnabled(context.snap, "angles")) return null;
  const element = context.elements.find(({ id }) => id === action.elementId);
  if (element === undefined || !isLinearElement(element)) return null;
  const opposite = worldLinearEndpoint(element, action.endpoint === "start" ? "end" : "start");
  const result = resolvePointAngleSnap({
    origin: opposite,
    point: context.currentPointer,
    snapPixels: HANDLE_SNAP_PIXELS,
    stepDegrees: 90,
    zoom: selectionSnapZoom(context.snap),
  });
  const replacement = editLinearEndpointFromWorld(
    element,
    action.endpoint,
    clampEndpoint(result.point, opposite),
    { straightTolerance: HANDLE_SNAP_PIXELS / selectionSnapZoom(context.snap) },
  );
  if (element.bend === null ? !result.snapped : replacement.bend !== null) return null;
  return {
    end: replacement[action.endpoint],
    kind: "angular",
    start: replacement[action.endpoint === "start" ? "end" : "start"],
  };
}

function bendSnapGuide(
  action: Extract<SelectionHandleAction, { kind: "linear-bend" }>,
  context: TargetedGuideContext,
): SelectionSnapGuide | null {
  const { currentPointer, elements, snap } = context;
  const element = elements.find(({ id }) => id === action.elementId);
  if (element === undefined) throw new RangeError("The handle target is not selected.");
  const guide = linearBendSnapGuide(
    element,
    currentPointer,
    HANDLE_SNAP_PIXELS / selectionSnapZoom(snap),
  );
  return guide === null ? null : { ...guide, kind: "bend" };
}

function coordinateSnapGuide(
  action: Extract<SelectionHandleAction, { kind: "coordinate-axis" | "coordinate-origin" }>,
  context: TargetedGuideContext,
): SelectionSnapGuide | null {
  const element = context.elements.find(({ id }) => id === action.elementId);
  if (element?.kind !== "coordinate-system") return null;
  const zoom = selectionSnapZoom(context.snap);
  if (action.kind === "coordinate-axis") {
    const result = resolveCoordinateAxisSnap(
      element,
      context.currentPointer,
      HANDLE_SNAP_PIXELS,
      zoom,
    );
    return result.snapped
      ? {
          end: result.point,
          kind: "angular",
          start: rotatePointClockwise(element.origin, element.pivot, element.rotation),
        }
      : null;
  }
  const result = resolveCoordinateOriginSnap(
    element,
    context.currentPointer,
    HANDLE_SNAP_PIXELS,
    zoom,
  );
  return result.snapped && result.reference !== null
    ? { end: result.point, kind: "angular", start: result.reference }
    : null;
}

function tableSnapGuide(
  action: Extract<SelectionHandleAction, { kind: "table-column" | "table-header" }>,
  context: TargetedGuideContext,
): SelectionSnapGuide | null {
  const element = context.elements.find(({ id }) => id === action.elementId);
  if (element?.kind !== "table") return null;
  const localPointer = rotatePointClockwise(
    context.currentPointer,
    element.pivot,
    -element.rotation,
  );
  const tolerance = HANDLE_SNAP_PIXELS / selectionSnapZoom(context.snap);
  const result =
    action.kind === "table-header"
      ? resolveTableHeaderSnap(element, localPointer, tolerance)
      : resolveTableColumnSnap(element, action.separatorIndex, localPointer, tolerance);
  if (!result.snapped) return null;
  const width = element.columns * element.columnWidth;
  const localStart =
    action.kind === "table-header"
      ? { x: element.x, y: result.point.y }
      : { x: result.point.x, y: element.y };
  const localEnd =
    action.kind === "table-header"
      ? { x: element.x + width, y: result.point.y }
      : { x: result.point.x, y: element.y + element.height };
  const localHandle =
    action.kind === "table-header"
      ? { x: element.x + width / 2, y: result.point.y }
      : { x: result.point.x, y: element.y + element.height / 2 };
  const world = (point: PointV1) => rotatePointClockwise(point, element.pivot, element.rotation);
  return {
    end: world(localEnd),
    handle: world(localHandle),
    kind: "separator",
    start: world(localStart),
  };
}

export function linearEndpointSnapPoint(
  element: InkElementV1,
  endpoint: "start" | "end",
  pointer: PointV1,
  candidate: SnapCandidate | null,
  snap: SelectionSnapPorts | undefined,
): PointV1 {
  if (!isLinearElement(element)) throw new TypeError("Expected a linear drawing element.");
  if (candidate !== null) return candidate.point;
  if (!selectionSnapFeatureEnabled(snap, "angles")) return pointer;
  const opposite = worldLinearEndpoint(element, endpoint === "start" ? "end" : "start");
  return resolvePointAngleSnap({
    origin: opposite,
    point: pointer,
    snapPixels: HANDLE_SNAP_PIXELS,
    stepDegrees: 90,
    zoom: selectionSnapZoom(snap),
  }).point;
}

export function selectionSnapZoom(snap: SelectionSnapPorts | undefined): number {
  const zoom = snap?.zoom ?? 1;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function rotationGuide(
  action: Extract<SelectionHandleAction, { kind: "rotate" }>,
  startPointer: PointV1,
  currentPointer: PointV1,
  snap: SelectionSnapPorts | undefined,
): SelectionSnapGuide | null {
  const result = resolveRotationSnap({
    center: action.center,
    currentPointer,
    referenceRotation: action.referenceRotation,
    snapPixels: HANDLE_SNAP_PIXELS,
    startPointer,
    zoom: selectionSnapZoom(snap),
    enabled: selectionSnapFeatureEnabled(snap, "angles"),
  });
  return result.snapped
    ? {
        handle: rotatePointClockwise(startPointer, action.center, result.delta),
        kind: "rotation",
        opposite: rotatePointClockwise(action.opposite, action.center, result.delta),
      }
    : null;
}
