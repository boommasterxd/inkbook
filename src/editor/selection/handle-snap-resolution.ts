import { rotatePointClockwise } from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";
import type { SnapCandidate } from "../snapping/snap-candidate";

import type { SelectionHandleAction, SelectionSnapGuide, SelectionSnapPorts } from "./handle-types";
import { linearBendSnapGuide } from "./linear-bend";
import { resolveRotationSnap } from "./rotation-snap";

export const HANDLE_SNAP_PIXELS = 5;

export function selectionRotationDelta(
  action: SelectionHandleAction,
  elements: readonly InkElementV1[],
  startPointer: PointV1,
  currentPointer: PointV1,
  snap: SelectionSnapPorts | undefined,
): number {
  if (action.kind !== "rotate") throw new Error("Expected a rotate action.");
  return resolveRotationSnap({
    center: action.center,
    currentPointer,
    referenceRotation: elements[0]!.rotation,
    snapPixels: HANDLE_SNAP_PIXELS,
    startPointer,
    zoom: selectionSnapZoom(snap),
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
  if (action.kind === "linear-endpoint") {
    return candidate === null ? null : { kind: "anchor", point: candidate.point };
  }
  if (action.kind === "rotate") {
    return rotationGuide(action, elements[0]!, startPointer, currentPointer, snap);
  }
  if (action.kind !== "linear-bend") return null;
  const element = elements.find(({ id }) => id === action.elementId);
  if (element === undefined) throw new RangeError("The handle target is not selected.");
  const guide = linearBendSnapGuide(
    element,
    currentPointer,
    HANDLE_SNAP_PIXELS / selectionSnapZoom(snap),
  );
  return guide === null ? null : { ...guide, kind: "bend" };
}

export function selectionSnapZoom(snap: SelectionSnapPorts | undefined): number {
  const zoom = snap?.zoom ?? 1;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function rotationGuide(
  action: Extract<SelectionHandleAction, { kind: "rotate" }>,
  reference: InkElementV1,
  startPointer: PointV1,
  currentPointer: PointV1,
  snap: SelectionSnapPorts | undefined,
): SelectionSnapGuide | null {
  const result = resolveRotationSnap({
    center: action.center,
    currentPointer,
    referenceRotation: reference.rotation,
    snapPixels: HANDLE_SNAP_PIXELS,
    startPointer,
    zoom: selectionSnapZoom(snap),
  });
  return result.snapped
    ? {
        center: action.center,
        handle: rotatePointClockwise(startPointer, action.center, result.delta),
        kind: "rotation",
      }
    : null;
}
