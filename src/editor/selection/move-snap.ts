import { rotatePointClockwise } from "../../domain/geometry/public";
import type { EndpointConnectionV1, InkElementV1, PointV1 } from "../../domain/schema/public";
import {
  findSnapCandidate,
  type SnapCandidate,
  type SnapCandidateScratch,
  type SnapPointerType,
  type SnapTargetReader,
  type SpatialCandidateQuery,
} from "../snapping/snap-candidate";

import { moveSelection } from "./transforms";

const MAX_SNAPPING_SELECTION_SIZE = 1_000;

export interface SelectionMoveSnap {
  readonly candidate: SnapCandidate;
  readonly delta: PointV1;
  readonly elementId: string;
  readonly endpoint: "end" | "start";
}

interface SelectionMoveSnapInput {
  readonly current: SelectionMoveSnap | null;
  readonly elements: readonly InkElementV1[];
  readonly pointerType: SnapPointerType;
  readonly rawDelta: PointV1;
  readonly scratch: SnapCandidateScratch;
  readonly selectedIds: ReadonlySet<string>;
  readonly spatial: SpatialCandidateQuery;
  readonly targets: SnapTargetReader;
  readonly zoom: number;
}

export function resolveSelectionMoveSnap(input: SelectionMoveSnapInput): SelectionMoveSnap | null {
  if (input.elements.length > MAX_SNAPPING_SELECTION_SIZE) return null;
  let best: SelectionMoveSnap | null = null;
  for (const element of input.elements) {
    if (element.kind !== "line" && element.kind !== "arrow") continue;
    for (const endpoint of ["start", "end"] as const) {
      const connection = endpoint === "start" ? element.startConnection : element.endConnection;
      if (connection !== null) continue;
      const world = rotatePointClockwise(element[endpoint], element.pivot, element.rotation);
      const proposed = { x: world.x + input.rawDelta.x, y: world.y + input.rawDelta.y };
      const candidate = findSnapCandidate(
        {
          current:
            input.current?.elementId === element.id && input.current.endpoint === endpoint
              ? input.current.candidate
              : null,
          pointer: proposed,
          pointerType: input.pointerType,
          zoom: input.zoom,
        },
        input.spatial,
        {
          get: (id) => (input.selectedIds.has(id) ? null : input.targets.get(id)),
        },
        input.scratch,
      );
      if (candidate === null) continue;
      const snap: SelectionMoveSnap = {
        candidate,
        delta: {
          x: input.rawDelta.x + candidate.point.x - proposed.x,
          y: input.rawDelta.y + candidate.point.y - proposed.y,
        },
        elementId: element.id,
        endpoint,
      };
      if (best === null || moveSnapPrecedes(snap, best)) best = snap;
    }
  }
  return best;
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

function moveSnapPrecedes(left: SelectionMoveSnap, right: SelectionMoveSnap): boolean {
  if (left.candidate.distancePixels !== right.candidate.distancePixels) {
    return left.candidate.distancePixels < right.candidate.distancePixels;
  }
  const elementOrder = left.elementId.localeCompare(right.elementId);
  if (elementOrder !== 0) return elementOrder < 0;
  return left.endpoint === "start" && right.endpoint === "end";
}
