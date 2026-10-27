import {
  canonicalPoint,
  isAnchorTarget,
  linearPivot,
  resolveShapeAnchor,
  rotatePointClockwise,
} from "../../domain/geometry/public";
import type { EndpointConnectionV1, InkElementV1, PointV1 } from "../../domain/schema/public";
import type { FrameCancellation, WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { ElementStore } from "../../domain/store/public";

import type { SelectionPreviewTransform } from "./handle-types";
import { transformSelectionPoint } from "./overlay-geometry";
import { editLinearEndpointFromWorld } from "./transform/transforms";
import { exceedsExactLinearPreviewWork } from "./selection-work-budget";
import {
  connectedPreviewPlanSteps,
  type ConnectedPreviewPlan,
  type ConnectedLinear,
} from "./connection-preview-plan";

export interface ConnectedSelectionPreview {
  readonly elements: readonly ConnectedLinear[];
  readonly selectedPreviewIds: ReadonlySet<string>;
  readonly progressive?: {
    readonly ids: readonly string[];
    readonly materialize: (id: string) => ConnectedLinear | undefined;
  };
}

export class ConnectedSelectionPreviewSession {
  readonly #selectedIds: ReadonlySet<string>;
  readonly #selected = new Map<string, InkElementV1>();
  readonly #selectedPreviewIds = new Set<string>();
  readonly #steps: Generator<number, ConnectedPreviewPlan>;
  #plan: ConnectedPreviewPlan | undefined;
  #valid = true;
  #generation = 0;
  readonly #unsubscribe: () => void;

  public constructor(
    store: ElementStore,
    selectedElements: readonly InkElementV1[],
    selectedIds: ReadonlySet<string>,
  ) {
    this.#selectedIds = selectedIds;
    for (const element of selectedElements) {
      if (isAnchorTarget(element)) this.#selected.set(element.id, element);
      if (isConnectedLinear(element)) this.#selectedPreviewIds.add(element.id);
    }
    this.#steps = connectedPreviewPlanSteps(store, selectedIds, this.#selected.keys());
    this.#unsubscribe = store.subscribe(() => {
      this.#valid = false;
    });
    // The existing exact-preview membership bound selects the synchronous path.
    let step = this.#steps.next();
    while (!step.done && !exceedsExactLinearPreviewWork(step.value)) step = this.#steps.next();
    if (step.done) this.#plan = step.value;
  }

  public get selectedPreviewIds(): ReadonlySet<string> {
    return this.#selectedPreviewIds;
  }

  public get requiresPreparation(): boolean {
    return this.#plan === undefined || exceedsExactLinearPreviewWork(this.#plan.ids.length);
  }

  public async prepare(scheduler: WorkScheduler, signal: FrameCancellation): Promise<boolean> {
    if (this.#plan !== undefined) return false;
    while (this.#valid && !signal.aborted) {
      const checkpoint = scheduler.checkpoint(signal, "input");
      if (checkpoint !== undefined) await checkpoint;
      if (!this.#valid || signal.aborted) return false;
      const step = this.#steps.next();
      if (step.done) {
        this.#plan = step.value;
        return true;
      }
    }
    return false;
  }

  public dispose(): void {
    this.#valid = false;
    this.#steps.return({ bindings: new Map(), ids: [] });
    this.#plan = undefined;
    this.#unsubscribe();
  }

  public update(
    transform: SelectionPreviewTransform,
    materializeRoot?: (id: string) => InkElementV1 | undefined,
  ): ConnectedSelectionPreview {
    const targets = new Map<string, InkElementV1>();
    for (const id of this.#selectedPreviewIds) {
      const element = this.#selected.get(id)! as ConnectedLinear;
      const exact = materializeRoot?.(id);
      targets.set(
        id,
        exact?.kind === "line" || exact?.kind === "arrow"
          ? exact
          : transformLinear(element, this.#selectedIds, transform, true),
      );
    }
    return this.#preview(targets, transform, materializeRoot);
  }

  public updateTargets(elements: readonly InkElementV1[]): ConnectedSelectionPreview {
    const targets = new Map<string, InkElementV1>();
    for (const element of elements) {
      if (isAnchorTarget(element)) targets.set(element.id, element);
    }
    return this.#preview(targets, null);
  }

  #preview(
    targets: Map<string, InkElementV1>,
    transform: SelectionPreviewTransform | null,
    materializeRoot?: (id: string) => InkElementV1 | undefined,
  ): ConnectedSelectionPreview {
    const generation = ++this.#generation;
    const elements: ConnectedLinear[] = [];
    for (const element of targets.values()) {
      if (element.kind === "line" || element.kind === "arrow") elements.push(element);
    }
    if (!this.#valid) return { elements: [], selectedPreviewIds: this.#selectedPreviewIds };
    const roots = new Map<EndpointConnectionV1, PointV1 | null>();
    const plan = this.#plan;
    if (plan === undefined || plan.ids.length === 0) {
      return { elements, selectedPreviewIds: this.#selectedPreviewIds };
    }
    const materialize = (id: string): ConnectedLinear | undefined => {
      if (!this.#valid || generation !== this.#generation) return undefined;
      const binding = plan.bindings.get(id);
      if (binding === undefined) return undefined;
      let resolved = binding.element;
      for (const endpoint of ["start", "end"] as const) {
        const root = binding[endpoint];
        if (root === null) continue;
        if (!roots.has(root))
          roots.set(root, this.#rootPoint(root, targets, transform, materializeRoot));
        const point = roots.get(root);
        if (point === null || point === undefined) continue;
        const connection = endpoint === "start" ? resolved.startConnection : resolved.endConnection;
        resolved = editLinearEndpointFromWorld(resolved, endpoint, point, {
          connection,
        }) as ConnectedLinear;
      }
      return resolved;
    };
    if (!exceedsExactLinearPreviewWork(plan.ids.length + targets.size)) {
      for (const id of plan.ids) {
        const element = materialize(id);
        if (element !== undefined) elements.push(element);
      }
      return { elements, selectedPreviewIds: this.#selectedPreviewIds };
    }
    return {
      elements,
      selectedPreviewIds: this.#selectedPreviewIds,
      progressive: { ids: plan.ids, materialize },
    };
  }

  #rootPoint(
    root: EndpointConnectionV1,
    targets: Map<string, InkElementV1>,
    transform: SelectionPreviewTransform | null,
    materializeRoot: ((id: string) => InkElementV1 | undefined) | undefined,
  ): PointV1 | null {
    let target = targets.get(root.targetId) ?? materializeRoot?.(root.targetId);
    if (target !== undefined) targets.set(root.targetId, target);
    const selected = this.#selected.get(root.targetId);
    if (
      target === undefined &&
      transform !== null &&
      selected !== undefined &&
      (selected.kind === "line" || selected.kind === "arrow")
    ) {
      target = transformLinear(selected, this.#selectedIds, transform, true);
      targets.set(target.id, target);
    }
    if (target !== undefined)
      return isAnchorTarget(target) ? resolveShapeAnchor(target, root.anchor) : null;
    if (transform === null || selected === undefined || !isAnchorTarget(selected)) return null;
    const point = resolveShapeAnchor(selected, root.anchor);
    return point === null ? null : transformSelectionPoint(point, transform);
  }
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
