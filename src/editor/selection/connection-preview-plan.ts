import type { EndpointConnectionV1, InkElementV1 } from "../../domain/schema/public";
import type { ElementStore } from "../../domain/store/public";

// Only fixed-size topology bookkeeping is grouped; discovery and preview work keep their gates.
const TOPOLOGY_RECORDS_PER_STEP = 32;

export type ConnectedLinear = Extract<InkElementV1, { kind: "arrow" | "line" }>;
export interface ConnectedPreviewBinding {
  readonly element: ConnectedLinear;
  readonly start: EndpointConnectionV1 | null;
  readonly end: EndpointConnectionV1 | null;
}
export interface ConnectedPreviewPlan {
  readonly bindings: ReadonlyMap<string, ConnectedPreviewBinding>;
  readonly ids: readonly string[];
}

interface ConnectedPreviewOrder {
  readonly indegrees: Map<string, number>;
  readonly downstream: Map<string, string[]>;
  readonly ready: string[];
}

/** Compiles endpoint ancestry once; every intermediate endpoint is canonical world geometry. */
export function* connectedPreviewPlanSteps(
  store: ElementStore,
  selectedIds: ReadonlySet<string>,
  roots: Iterable<string>,
  selectedPreviewIds: Iterable<string> = [],
): Generator<number, ConnectedPreviewPlan> {
  const elements = new Map<string, ConnectedLinear>();
  const queue: string[] = [];
  const visited = new Set<string>();
  const ids: string[] = [];
  for (const id of selectedPreviewIds) {
    ids.push(id);
    yield ids.length;
  }
  for (const id of roots) {
    queue.push(id);
    visited.add(id);
    yield queue.length;
  }
  const selectedCount = queue.length;
  let references = 0;
  for (let index = 0; index < queue.length; index += 1) {
    yield Math.max(selectedCount, elements.size, references);
    for (const { linearId } of store.beginDependents(queue[index]!)) {
      references += 1;
      if (selectedIds.has(linearId) || visited.has(linearId)) {
        yield Math.max(selectedCount, elements.size, references);
        continue;
      }
      visited.add(linearId);
      const element = store.get(linearId)?.element;
      if (element !== undefined && (element.kind === "line" || element.kind === "arrow")) {
        elements.set(linearId, element);
        queue.push(linearId);
      }
      yield Math.max(selectedCount, elements.size, references);
    }
  }
  const order = yield* dependentOrderSteps(elements);
  return yield* bindConnectedPreviewSteps(elements, selectedIds, ids, order);
}

function* bindConnectedPreviewSteps(
  elements: ReadonlyMap<string, ConnectedLinear>,
  selectedIds: ReadonlySet<string>,
  ids: string[],
  { indegrees, downstream, ready }: ConnectedPreviewOrder,
): Generator<number, ConnectedPreviewPlan> {
  const bindings = new Map<string, ConnectedPreviewBinding>();
  let prepared = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index]!;
    const element = elements.get(id)!;
    const start = rootConnection(element.startConnection, selectedIds, bindings);
    const end = rootConnection(element.endConnection, selectedIds, bindings);
    bindings.set(id, { element, start, end });
    if (start !== null || end !== null) ids.push(id);
    if (++prepared === TOPOLOGY_RECORDS_PER_STEP) {
      prepared = 0;
      yield elements.size;
    }
    for (const dependent of downstream.get(id) ?? []) {
      const remaining = indegrees.get(dependent)! - 1;
      indegrees.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
      if (++prepared === TOPOLOGY_RECORDS_PER_STEP) {
        prepared = 0;
        yield elements.size;
      }
    }
  }
  if (prepared > 0) yield elements.size;
  if (bindings.size !== elements.size) {
    throw new RangeError("Connected preview dependencies must remain acyclic.");
  }
  return { bindings, ids };
}

function* dependentOrderSteps(
  elements: ReadonlyMap<string, ConnectedLinear>,
): Generator<number, ConnectedPreviewOrder> {
  const indegrees = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  let visited = 0;
  for (const element of elements.values()) {
    let degree = 0;
    for (const connection of [element.startConnection, element.endConnection]) {
      if (connection === null || !elements.has(connection.targetId)) continue;
      degree += 1;
      const ids = downstream.get(connection.targetId) ?? [];
      ids.push(element.id);
      downstream.set(connection.targetId, ids);
    }
    indegrees.set(element.id, degree);
    if (++visited % TOPOLOGY_RECORDS_PER_STEP === 0) yield elements.size;
  }
  if (visited % TOPOLOGY_RECORDS_PER_STEP !== 0) yield elements.size;
  const ready: string[] = [];
  visited = 0;
  for (const [id, degree] of indegrees) {
    if (degree === 0) ready.push(id);
    if (++visited % TOPOLOGY_RECORDS_PER_STEP === 0) yield elements.size;
  }
  if (visited % TOPOLOGY_RECORDS_PER_STEP !== 0) yield elements.size;
  return { indegrees, downstream, ready };
}

function rootConnection(
  connection: EndpointConnectionV1 | null,
  selectedIds: ReadonlySet<string>,
  bindings: ReadonlyMap<string, ConnectedPreviewBinding>,
): EndpointConnectionV1 | null {
  if (connection === null || selectedIds.has(connection.targetId)) return connection;
  const target = bindings.get(connection.targetId);
  return connection.anchor.kind === "linear-endpoint"
    ? (target?.[connection.anchor.endpoint] ?? null)
    : null;
}
