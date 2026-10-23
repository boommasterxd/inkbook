import { renderBandOf } from "../../../domain/commands/render-bands";
import { derivePageExtent } from "../../../domain/geometry/public";
import {
  CLIPBOARD_SCHEMA_LIMITS,
  FILE_SCHEMA_LIMITS,
  type EndpointConnectionV1,
  type InkElementV1,
  type PageV1,
} from "../../../domain/schema/public";
import {
  MAX_ELEMENT_CELLS,
  MAX_SPATIAL_MEMBERSHIPS,
  SPATIAL_CELL_SIZE,
} from "../../../domain/spatial/index";
import type { ElementStore, StoreDelta, StoreSliceScheduler } from "../../../domain/store/public";
import { MutationPreparationScheduler } from "../../../domain/store/mutations/mutation-preparation-scheduler";
import {
  prepareInsertionElementSteps,
  preparedInsertionBounds,
} from "../../../domain/store/mutations/prepared-insertion-element";
import type { PastePlan } from "../../../persistence/clipboard/public";
import { capturePastePlan } from "../../../persistence/clipboard/paste-plan-snapshot";

interface DocumentFacts {
  connectedEndpoints: number;
  elements: number;
  overflowElements: number;
  spatialMemberships: number;
  strokePoints: number;
  strokes: number;
}

interface FactElement {
  readonly endConnection?: EndpointConnectionV1 | null;
  readonly kind: InkElementV1["kind"];
  readonly points?: ArrayLike<number>;
  readonly startConnection?: EndpointConnectionV1 | null;
}

export interface PreparedClipboardAdoption {
  readonly elements: readonly InkElementV1[];
  readonly facts: Readonly<DocumentFacts>;
  readonly fanout: ReadonlyMap<string, number>;
  readonly ids: ReadonlySet<string>;
  readonly maximumBottom: number | null;
  readonly targetIds: ReadonlySet<string>;
}

export class ClipboardAdoptionGuard {
  readonly #facts: DocumentFacts = emptyFacts();
  readonly #fanout = new Map<string, number>();
  readonly #store: ElementStore;
  readonly #unsubscribe: () => void;

  public constructor(store: ElementStore) {
    this.#store = store;
    for (const band of ["highlight", "content"] as const) {
      for (const id of store.materializeBandOrder(band)) {
        const record = store.get(id);
        if (record === undefined) throw new Error("The element store order is inconsistent.");
        addElementFacts(this.#facts, this.#fanout, record.element, record.bounds, 1);
      }
    }
    this.#unsubscribe = store.subscribe((delta) => this.#applyDelta(delta));
  }

  public dispose(): void {
    this.#unsubscribe();
  }

  public async prepare(
    plan: PastePlan,
    scheduler: StoreSliceScheduler,
  ): Promise<PreparedClipboardAdoption | null> {
    try {
      const captured = capturePastePlan(plan);
      if (captured === null) return null;
      plan = captured;
      const work = new MutationPreparationScheduler(scheduler);
      const ids = new Set(plan.selectedIds);
      if (ids.size !== plan.elements.length || ids.size > CLIPBOARD_SCHEMA_LIMITS.elements)
        return null;
      const facts = emptyFacts();
      const fanout = new Map<string, number>();
      const targetIds = new Set<string>();
      const elements: InkElementV1[] = [];
      let maximumBottom: number | null = null;
      for (const input of plan.elements) {
        if (!(work.checkpoint() || (await work.resume()))) return null;
        const pending = work.run(prepareInsertionElementSteps(input));
        const element = pending instanceof Promise ? await pending : pending;
        if (element === "cancelled") return null;
        const bounds = preparedInsertionBounds(element)!;
        elements.push(element);
        maximumBottom = Math.max(maximumBottom ?? bounds.maxY, bounds.maxY);
        addElementFacts(facts, fanout, element, bounds, 1);
        if (!connectionsHaveTargets(element, ids, this.#store)) return null;
        addConnectionTargets(element, targetIds);
      }
      if (scheduler.isCancelled?.() || consistentPlanIds({ ...plan, elements }) === null)
        return null;
      if (!withinClipboardLimits(facts, fanout)) return null;
      return { elements: Object.freeze(elements), facts, fanout, ids, maximumBottom, targetIds };
    } catch {
      return null;
    }
  }

  public accepts(prepared: PreparedClipboardAdoption, page: PageV1): boolean {
    if (this.#facts.elements !== this.#store.size) return false;
    for (const id of prepared.ids) if (this.#store.get(id) !== undefined) return false;
    for (const targetId of prepared.targetIds) {
      if (!prepared.ids.has(targetId) && this.#store.get(targetId) === undefined) return false;
    }
    const currentBottom = this.#store.getMaximumBottom() ?? null;
    const maximumBottom = Math.max(currentBottom ?? 0, prepared.maximumBottom ?? 0);
    return (
      withinDocumentLimits(this.#facts, prepared.facts, this.#fanout, prepared.fanout) &&
      derivePageExtent(page, maximumBottom).activeHeight <= FILE_SCHEMA_LIMITS.maximumDerivedHeight!
    );
  }

  #applyDelta(delta: StoreDelta): void {
    for (const change of delta.changes) {
      if (change.before !== null) {
        addElementFacts(this.#facts, this.#fanout, change.before.element, change.before.bounds, -1);
      }
      if (change.after !== null) {
        addElementFacts(this.#facts, this.#fanout, change.after.element, change.after.bounds, 1);
      }
    }
  }
}

function emptyFacts(): DocumentFacts {
  return {
    connectedEndpoints: 0,
    elements: 0,
    overflowElements: 0,
    spatialMemberships: 0,
    strokePoints: 0,
    strokes: 0,
  };
}

function addElementFacts(
  facts: DocumentFacts,
  fanout: Map<string, number>,
  element: FactElement,
  bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  },
  direction: 1 | -1,
): void {
  facts.elements += direction;
  if (element.kind === "stroke") {
    facts.strokes += direction;
    facts.strokePoints += direction * ((element.points?.length ?? 0) / 3);
  }
  const memberships = spatialMemberships(bounds);
  if (memberships === 0) facts.overflowElements += direction;
  else facts.spatialMemberships += direction * memberships;
  if (element.kind !== "line" && element.kind !== "arrow") return;
  for (const connection of [element.startConnection, element.endConnection]) {
    if (connection === null || connection === undefined) continue;
    facts.connectedEndpoints += direction;
    const count = (fanout.get(connection.targetId) ?? 0) + direction;
    if (count === 0) fanout.delete(connection.targetId);
    else fanout.set(connection.targetId, count);
  }
}

function spatialMemberships(bounds: {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}): number {
  const columns =
    Math.floor(bounds.maxX / SPATIAL_CELL_SIZE) - Math.floor(bounds.minX / SPATIAL_CELL_SIZE) + 1;
  const rows =
    Math.floor(bounds.maxY / SPATIAL_CELL_SIZE) - Math.floor(bounds.minY / SPATIAL_CELL_SIZE) + 1;
  return columns > MAX_ELEMENT_CELLS || rows > Math.floor(MAX_ELEMENT_CELLS / columns)
    ? 0
    : columns * rows;
}

function consistentPlanIds(plan: PastePlan): Set<string> | null {
  if (
    plan.insertAtBandFront !== true ||
    plan.activateTool !== "select" ||
    !Number.isSafeInteger(plan.commandTimestamp) ||
    plan.commandTimestamp < 0
  ) {
    return null;
  }
  const ids = new Set<string>();
  const highlights = new Set<string>();
  const contents = new Set<string>();
  for (const element of plan.elements) {
    ids.add(element.id);
    (renderBandOf(element) === "highlight" ? highlights : contents).add(element.id);
  }
  return ids.size === plan.elements.length &&
    sameIds(ids, plan.selectedIds) &&
    sameIds(highlights, plan.highlightIds) &&
    sameIds(contents, plan.contentIds)
    ? ids
    : null;
}

function sameIds(expected: ReadonlySet<string>, actual: readonly string[]): boolean {
  return (
    actual.length === expected.size &&
    new Set(actual).size === actual.length &&
    actual.every((id) => expected.has(id))
  );
}

function connectionsHaveTargets(
  element: InkElementV1,
  insertedIds: ReadonlySet<string>,
  store: ElementStore,
): boolean {
  if (element.kind !== "line" && element.kind !== "arrow") return true;
  return [element.startConnection, element.endConnection].every(
    (connection) =>
      connection === null ||
      insertedIds.has(connection.targetId) ||
      store.get(connection.targetId) !== undefined,
  );
}

function addConnectionTargets(element: InkElementV1, targetIds: Set<string>): void {
  if (element.kind !== "line" && element.kind !== "arrow") return;
  if (element.startConnection !== null) targetIds.add(element.startConnection.targetId);
  if (element.endConnection !== null) targetIds.add(element.endConnection.targetId);
}

function withinClipboardLimits(facts: DocumentFacts, fanout: ReadonlyMap<string, number>): boolean {
  return withinLimits(facts, fanout, CLIPBOARD_SCHEMA_LIMITS);
}

function withinDocumentLimits(
  current: DocumentFacts,
  inserted: DocumentFacts,
  currentFanout: ReadonlyMap<string, number>,
  insertedFanout: ReadonlyMap<string, number>,
): boolean {
  const combined: DocumentFacts = {
    connectedEndpoints: current.connectedEndpoints + inserted.connectedEndpoints,
    elements: current.elements + inserted.elements,
    overflowElements: current.overflowElements + inserted.overflowElements,
    spatialMemberships: current.spatialMemberships + inserted.spatialMemberships,
    strokePoints: current.strokePoints + inserted.strokePoints,
    strokes: current.strokes + inserted.strokes,
  };
  for (const [targetId, count] of insertedFanout) {
    if (
      (currentFanout.get(targetId) ?? 0) + count >
      FILE_SCHEMA_LIMITS.connectedEndpointsPerTarget
    ) {
      return false;
    }
  }
  return withinLimits(combined, undefined, FILE_SCHEMA_LIMITS);
}

function withinLimits(
  facts: DocumentFacts,
  fanout: ReadonlyMap<string, number> | undefined,
  limits: typeof FILE_SCHEMA_LIMITS,
): boolean {
  if (!(
    facts.elements > 0 &&
    facts.elements <= limits.elements &&
    facts.strokes <= limits.strokes &&
    facts.strokePoints <= limits.strokePoints &&
    facts.connectedEndpoints <= limits.connectedEndpoints &&
    facts.overflowElements <= limits.spatialIndexOverflowElements &&
    facts.spatialMemberships <= MAX_SPATIAL_MEMBERSHIPS
  )) {
    return false;
  }
  if (fanout !== undefined) {
    for (const count of fanout.values()) {
      if (count > limits.connectedEndpointsPerTarget) return false;
    }
  }
  return true;
}
