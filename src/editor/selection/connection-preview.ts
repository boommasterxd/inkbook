import {
  canonicalPoint,
  linearPivot,
  pointDistance,
  rotatePointClockwise,
} from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";
import type { ElementStore } from "../../domain/store/public";

import type { SelectionPreviewTransform } from "./handle-types";
import { transformSelectionPoint } from "./overlay-geometry";

type ConnectedLinear = Extract<InkElementV1, { kind: "arrow" | "line" }>;

export interface ConnectedSelectionPreview {
  readonly elements: readonly ConnectedLinear[];
  readonly selectedPreviewIds: ReadonlySet<string>;
}

export function connectedSelectionTransformPreview(
  store: ElementStore,
  selectedElements: readonly InkElementV1[],
  selectedIds: ReadonlySet<string>,
  transform: SelectionPreviewTransform,
  connectedTargetIds: readonly string[] = selectedElements.map(({ id }) => id),
): ConnectedSelectionPreview {
  const previews = new Map<string, ConnectedLinear>();
  const selectedPreviewIds = new Set<string>();
  for (const element of selectedElements) {
    if (!isConnectedLinear(element)) continue;
    previews.set(element.id, transformLinear(element, selectedIds, transform, true));
    selectedPreviewIds.add(element.id);
  }
  for (const targetId of connectedTargetIds) {
    store.visitDependents(targetId, ({ linearId }) => {
      if (selectedIds.has(linearId)) return;
      const current = previews.get(linearId) ?? store.get(linearId)?.element;
      if (current === undefined || (current.kind !== "line" && current.kind !== "arrow")) return;
      previews.set(linearId, transformLinear(current, selectedIds, transform, false));
    });
  }
  return { elements: [...previews.values()], selectedPreviewIds };
}

export function exactConnectedSelectionIds(
  elements: readonly InkElementV1[],
  selectedIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const element of elements) {
    if (selectedIds.has(element.id) && isConnectedLinear(element)) ids.add(element.id);
  }
  return ids;
}

function transformLinear(
  element: ConnectedLinear,
  selectedIds: ReadonlySet<string>,
  transform: SelectionPreviewTransform,
  selected: boolean,
): ConnectedLinear {
  const world = (point: PointV1) => rotatePointClockwise(point, element.pivot, element.rotation);
  const start = transformEndpoint(element, "start", selectedIds, transform, selected, world);
  const end = transformEndpoint(element, "end", selectedIds, transform, selected, world);
  if (pointDistance(start, end) < 8) return element;
  const bend =
    element.bend === null
      ? null
      : selected
        ? transformSelectionPoint(world(element.bend), transform)
        : canonicalPoint(world(element.bend));
  return {
    ...element,
    bend,
    end,
    pivot: linearPivot(start, end, bend),
    rotation: 0,
    start,
  };
}

function transformEndpoint(
  element: ConnectedLinear,
  endpoint: "end" | "start",
  selectedIds: ReadonlySet<string>,
  transform: SelectionPreviewTransform,
  selected: boolean,
  world: (point: PointV1) => PointV1,
): PointV1 {
  const connection = endpoint === "start" ? element.startConnection : element.endConnection;
  const followsSelection = selected
    ? connection === null || selectedIds.has(connection.targetId)
    : connection !== null && selectedIds.has(connection.targetId);
  const point = world(element[endpoint]);
  return followsSelection ? transformSelectionPoint(point, transform) : canonicalPoint(point);
}

function isConnectedLinear(element: InkElementV1): element is ConnectedLinear {
  return (
    (element.kind === "line" || element.kind === "arrow") &&
    (element.startConnection !== null || element.endConnection !== null)
  );
}
