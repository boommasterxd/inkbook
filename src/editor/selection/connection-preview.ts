import {
  canonicalPoint,
  isAnchorTarget,
  linearPivot,
  pointDistance,
  resolveShapeAnchor,
  rotatePointClockwise,
} from "../../domain/geometry/public";
import type { EndpointConnectionV1, InkElementV1, PointV1 } from "../../domain/schema/public";
import type { ElementStore } from "../../domain/store/public";

import type { SelectionPreviewTransform } from "./handle-types";
import { transformSelectionPoint } from "./overlay-geometry";
import { editLinearEndpointFromWorld } from "./transforms";

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
  const transformedTargets = new Map<string, ConnectedLinear>();
  for (const element of selectedElements) {
    if (element.kind !== "line" && element.kind !== "arrow") continue;
    const transformed = transformLinear(element, selectedIds, transform, true);
    transformedTargets.set(element.id, transformed);
    if (isConnectedLinear(element)) {
      previews.set(element.id, transformed);
      selectedPreviewIds.add(element.id);
    }
  }
  const queue = [...connectedTargetIds];
  const queued = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    const targetId = queue[index]!;
    queued.delete(targetId);
    store.visitDependents(targetId, ({ linearId }) => {
      if (selectedIds.has(linearId)) return;
      const current = previews.get(linearId) ?? store.get(linearId)?.element;
      if (current === undefined || (current.kind !== "line" && current.kind !== "arrow")) return;
      const resolved = resolvePreviewConnections(current, {
        previews,
        selectedIds,
        store,
        transform,
        transformedTargets,
      });
      if (resolved === current) return;
      previews.set(linearId, resolved);
      if (!queued.has(linearId)) {
        queue.push(linearId);
        queued.add(linearId);
      }
    });
  }
  return { elements: [...previews.values()], selectedPreviewIds };
}

interface PreviewConnectionContext {
  readonly previews: ReadonlyMap<string, ConnectedLinear>;
  readonly selectedIds: ReadonlySet<string>;
  readonly store: ElementStore;
  readonly transform: SelectionPreviewTransform;
  readonly transformedTargets: ReadonlyMap<string, ConnectedLinear>;
}

function resolvePreviewConnections(
  element: ConnectedLinear,
  context: PreviewConnectionContext,
): ConnectedLinear {
  let resolved = element;
  for (const endpoint of ["start", "end"] as const) {
    const connection = endpoint === "start" ? element.startConnection : element.endConnection;
    const point = connection === null ? null : previewAnchor(connection, context);
    if (point === null) continue;
    resolved = editLinearEndpointFromWorld(resolved, endpoint, point, {
      connection,
    }) as ConnectedLinear;
  }
  return resolved;
}

function previewAnchor(
  connection: EndpointConnectionV1,
  context: PreviewConnectionContext,
): PointV1 | null {
  const linearTarget =
    context.transformedTargets.get(connection.targetId) ??
    context.previews.get(connection.targetId);
  if (linearTarget !== undefined) return resolveShapeAnchor(linearTarget, connection.anchor);
  const target = context.store.get(connection.targetId)?.element;
  if (target === undefined || !isAnchorTarget(target)) return null;
  const point = resolveShapeAnchor(target, connection.anchor);
  if (point === null || !context.selectedIds.has(connection.targetId)) return null;
  return transformSelectionPoint(point, context.transform);
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
