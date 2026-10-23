import {
  canonicalPoint,
  isAnchorTarget,
  linearPivot,
  resolveShapeAnchor,
  rotatePointClockwise,
} from "../../domain/geometry/public";
import type { EndpointConnectionV1, InkElementV1, PointV1 } from "../../domain/schema/public";
import type { ElementStore } from "../../domain/store/public";

import type { SelectionPreviewTransform } from "./handle-types";
import { transformSelectionPoint } from "./overlay-geometry";
import { editLinearEndpointFromWorld } from "./transform/transforms";
import { exceedsExactLinearPreviewWork } from "./selection-work-budget";

type ConnectedLinear = Extract<InkElementV1, { kind: "arrow" | "line" }>;

export interface ConnectedSelectionPreview {
  readonly elements: readonly ConnectedLinear[];
  readonly selectedPreviewIds: ReadonlySet<string>;
}

export class ConnectedSelectionPreviewSession {
  readonly #dependents: readonly ConnectedLinear[];
  readonly #selectedIds: ReadonlySet<string>;
  readonly #selectedLinears: readonly ConnectedLinear[];
  readonly #selectedPreviewIds: ReadonlySet<string>;
  readonly #store: ElementStore;

  public constructor(
    store: ElementStore,
    selectedElements: readonly InkElementV1[],
    selectedIds: ReadonlySet<string>,
  ) {
    this.#store = store;
    this.#selectedIds = selectedIds;
    const plan = createConnectedPreviewPlan(store, selectedElements, selectedIds);
    this.#dependents = plan.dependents;
    this.#selectedLinears = plan.selectedLinears;
    this.#selectedPreviewIds = plan.selectedPreviewIds;
  }

  public get selectedPreviewIds(): ReadonlySet<string> {
    return this.#selectedPreviewIds;
  }

  public update(transform: SelectionPreviewTransform): ConnectedSelectionPreview {
    const previews = new Map<string, ConnectedLinear>();
    const transformedTargets = new Map<string, ConnectedLinear>();
    for (const element of this.#selectedLinears) {
      const transformed = transformLinear(element, this.#selectedIds, transform, true);
      transformedTargets.set(element.id, transformed);
      if (this.#selectedPreviewIds.has(element.id)) previews.set(element.id, transformed);
    }
    return this.#resolveDependents(previews, transformedTargets, transform);
  }

  public updateTargets(elements: readonly InkElementV1[]): ConnectedSelectionPreview {
    const targets = new Map<string, ConnectedLinear>();
    for (const element of elements) {
      if (element.kind === "line" || element.kind === "arrow") targets.set(element.id, element);
    }
    if (exceedsExactLinearPreviewWork(targets.size + this.#dependents.length)) {
      return { elements: [...targets.values()], selectedPreviewIds: this.#selectedPreviewIds };
    }
    return this.#resolveDependents(new Map(targets), targets, null);
  }

  #resolveDependents(
    previews: Map<string, ConnectedLinear>,
    transformedTargets: ReadonlyMap<string, ConnectedLinear>,
    transform: SelectionPreviewTransform | null,
  ): ConnectedSelectionPreview {
    for (const element of this.#dependents) {
      const resolved = resolvePreviewConnections(element, {
        previews,
        selectedIds: this.#selectedIds,
        store: this.#store,
        transform,
        transformedTargets,
      });
      if (resolved !== element) previews.set(element.id, resolved);
    }
    return { elements: [...previews.values()], selectedPreviewIds: this.#selectedPreviewIds };
  }
}

interface ConnectedPreviewPlan {
  readonly dependents: readonly ConnectedLinear[];
  readonly selectedLinears: readonly ConnectedLinear[];
  readonly selectedPreviewIds: ReadonlySet<string>;
}

function createConnectedPreviewPlan(
  store: ElementStore,
  selectedElements: readonly InkElementV1[],
  selectedIds: ReadonlySet<string>,
): ConnectedPreviewPlan {
  const selectedLinears = new Map<string, ConnectedLinear>();
  const requiredSelectedIds = new Set<string>();
  const selectedPreviewIds = new Set<string>();
  for (const element of selectedElements) {
    if (element.kind !== "line" && element.kind !== "arrow") continue;
    selectedLinears.set(element.id, element);
    if (!isConnectedLinear(element)) continue;
    requiredSelectedIds.add(element.id);
    selectedPreviewIds.add(element.id);
  }
  const dependents = reachableDependents(store, selectedIds, requiredSelectedIds, selectedLinears);
  return {
    dependents: topologicalDependents(dependents),
    selectedLinears: [...requiredSelectedIds].flatMap((id) => {
      const element = selectedLinears.get(id);
      return element === undefined ? [] : [element];
    }),
    selectedPreviewIds,
  };
}

function reachableDependents(
  store: ElementStore,
  selectedIds: ReadonlySet<string>,
  requiredSelectedIds: Set<string>,
  selectedLinears: ReadonlyMap<string, ConnectedLinear>,
): Map<string, ConnectedLinear> {
  const dependents = new Map<string, ConnectedLinear>();
  const queue = [...selectedIds];
  const visited = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    const targetId = queue[index]!;
    store.visitDependents(targetId, ({ linearId }) => {
      if (selectedIds.has(linearId)) return;
      if (selectedLinears.has(targetId)) requiredSelectedIds.add(targetId);
      const element = store.get(linearId)?.element;
      if (element === undefined || (element.kind !== "line" && element.kind !== "arrow")) return;
      dependents.set(element.id, element);
      if (visited.has(element.id)) return;
      visited.add(element.id);
      queue.push(element.id);
    });
  }
  return dependents;
}

function topologicalDependents(
  dependents: ReadonlyMap<string, ConnectedLinear>,
): readonly ConnectedLinear[] {
  const indegrees = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const element of dependents.values()) {
    indegrees.set(element.id, 0);
    for (const connection of [element.startConnection, element.endConnection]) {
      if (connection === null || !dependents.has(connection.targetId)) continue;
      indegrees.set(element.id, (indegrees.get(element.id) ?? 0) + 1);
      const targets = downstream.get(connection.targetId) ?? [];
      targets.push(element.id);
      downstream.set(connection.targetId, targets);
    }
  }
  const queue = [...indegrees].filter(([, value]) => value === 0).map(([id]) => id);
  const ordered: ConnectedLinear[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    const element = dependents.get(id);
    if (element !== undefined) ordered.push(element);
    for (const dependentId of downstream.get(id) ?? []) {
      const remaining = (indegrees.get(dependentId) ?? 0) - 1;
      indegrees.set(dependentId, remaining);
      if (remaining === 0) queue.push(dependentId);
    }
  }
  if (ordered.length !== dependents.size) {
    throw new RangeError("Connected preview dependencies must remain acyclic.");
  }
  return ordered;
}

interface PreviewConnectionContext {
  readonly previews: ReadonlyMap<string, ConnectedLinear>;
  readonly selectedIds: ReadonlySet<string>;
  readonly store: ElementStore;
  readonly transform: SelectionPreviewTransform | null;
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
  if (context.transform === null) return null;
  const target = context.store.get(connection.targetId)?.element;
  if (target === undefined || !isAnchorTarget(target)) return null;
  const point = resolveShapeAnchor(target, connection.anchor);
  if (point === null || !context.selectedIds.has(connection.targetId)) return null;
  return transformSelectionPoint(point, context.transform);
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
