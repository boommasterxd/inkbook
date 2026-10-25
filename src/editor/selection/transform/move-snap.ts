import type { EndpointConnectionV1, InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { SnapCandidate } from "../../snapping/snap-candidate";

import { moveSelection } from "./transforms";

export interface SelectionMoveSnap {
  readonly candidate: SnapCandidate;
  readonly delta: PointV1;
  readonly elementId: string;
  readonly endpoint: "end" | "start";
}

export function moveSelectionWithSnap(
  elements: readonly InkElementV1[],
  delta: PointV1,
  snap: SelectionMoveSnap | null,
): InkElementV1[] {
  const moved = moveSelection(elements, delta);
  if (snap === null) return moved;
  return moved.map((element) => applyConnection(element, snap));
}

function applyConnection(element: InkElementV1, snap: SelectionMoveSnap): InkElementV1 {
  if (element.id !== snap.elementId || (element.kind !== "line" && element.kind !== "arrow")) {
    return element;
  }
  const connection: EndpointConnectionV1 = {
    anchor: snap.candidate.anchor,
    targetId: snap.candidate.targetId,
  };
  return snap.endpoint === "start"
    ? { ...element, startConnection: connection }
    : { ...element, endConnection: connection };
}

export function moveSnapPrecedes(left: SelectionMoveSnap, right: SelectionMoveSnap): boolean {
  if (left.candidate.distancePixels !== right.candidate.distancePixels) {
    return left.candidate.distancePixels < right.candidate.distancePixels;
  }
  const elementOrder = left.elementId.localeCompare(right.elementId);
  if (elementOrder !== 0) return elementOrder < 0;
  return left.endpoint === "start" && right.endpoint === "end";
}
