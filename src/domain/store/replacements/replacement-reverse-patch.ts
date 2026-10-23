import { FILE_SCHEMA_LIMITS } from "../../schema/constants";

import { connectionReferences } from "../records/connections";
import type { ReplacementCandidate } from "./replacement-planner";
import type { ElementRecord, EndpointReference, StoreSliceScheduler } from "../types";

export interface ReverseConnectionPatch {
  readonly references: EndpointReference[];
  readonly targetId: string;
}

interface ConnectionChanges {
  readonly additions: Map<string, EndpointReference[]>;
  readonly affectedTargetIds: Set<string>;
  readonly changedLinearIds: Set<string>;
  readonly removals: Map<string, EndpointReference[]>;
}

export function createReverseConnectionPatches(
  source: ReadonlyMap<string, readonly EndpointReference[]>,
  candidates: readonly ReplacementCandidate[],
  replacements: readonly ElementRecord[],
): readonly ReverseConnectionPatch[] {
  const changes = createConnectionChanges();
  for (let index = 0; index < candidates.length; index += 1) {
    collectConnectionChanges(candidates[index]!, replacements[index]!, changes);
  }

  const patches: ReverseConnectionPatch[] = [];
  for (const targetId of changes.affectedTargetIds) {
    const current = source.get(targetId) ?? [];
    assertExpectedRemovals(current, changes.removals.get(targetId) ?? []);
    const references = current.filter(({ linearId }) => !changes.changedLinearIds.has(linearId));
    references.push(...(changes.additions.get(targetId) ?? []));
    if (references.length > FILE_SCHEMA_LIMITS.connectedEndpointsPerTarget) {
      throw new RangeError("The per-target connected-endpoint limit was exceeded.");
    }
    patches.push(Object.freeze({ references, targetId }));
  }
  return Object.freeze(patches);
}

export async function createReverseConnectionPatchesTimeSliced(
  source: ReadonlyMap<string, readonly EndpointReference[]>,
  candidates: readonly ReplacementCandidate[],
  replacements: readonly ElementRecord[],
  scheduler: StoreSliceScheduler,
): Promise<
  { readonly patches: readonly ReverseConnectionPatch[]; readonly yields: number } | "cancelled"
> {
  const changes = createConnectionChanges();
  const slicer = new ReversePatchSlicer(scheduler);
  for (let index = 0; index < candidates.length; index += 1) {
    if (slicer.cancelled()) return "cancelled";
    collectConnectionChanges(candidates[index]!, replacements[index]!, changes);
    const continuation = slicer.checkpoint();
    if (
      continuation === "cancelled" ||
      (continuation !== "continue" && (await continuation) === "cancelled")
    )
      return "cancelled";
  }

  const patches: ReverseConnectionPatch[] = [];
  for (const targetId of changes.affectedTargetIds) {
    if (slicer.cancelled()) return "cancelled";
    const patch = await prepareTargetPatchTimeSliced(
      targetId,
      source.get(targetId) ?? [],
      changes.changedLinearIds,
      changes.removals.get(targetId) ?? [],
      changes.additions.get(targetId) ?? [],
      slicer,
    );
    if (patch === "cancelled") return patch;
    patches.push(patch);
    const continuation = slicer.checkpoint();
    if (
      continuation === "cancelled" ||
      (continuation !== "continue" && (await continuation) === "cancelled")
    )
      return "cancelled";
  }
  return { patches: Object.freeze(patches), yields: slicer.yields };
}

async function prepareTargetPatchTimeSliced(
  targetId: string,
  current: readonly EndpointReference[],
  changedLinearIds: ReadonlySet<string>,
  removals: readonly EndpointReference[],
  additions: readonly EndpointReference[],
  slicer: ReversePatchSlicer,
): Promise<ReverseConnectionPatch | "cancelled"> {
  const keys = new Set<string>();
  const references: EndpointReference[] = [];
  for (const reference of current) {
    const key = referenceKey(reference);
    if (keys.has(key)) throw new Error("The reverse-connection map contains duplicates.");
    keys.add(key);
    if (!changedLinearIds.has(reference.linearId)) references.push(reference);
    const continuation = slicer.checkpoint();
    if (
      continuation === "cancelled" ||
      (continuation !== "continue" && (await continuation) === "cancelled")
    )
      return "cancelled";
  }
  for (const removal of removals) {
    if (!keys.has(referenceKey(removal))) {
      throw new Error("The reverse-connection map is inconsistent.");
    }
    const continuation = slicer.checkpoint();
    if (
      continuation === "cancelled" ||
      (continuation !== "continue" && (await continuation) === "cancelled")
    )
      return "cancelled";
  }
  for (const addition of additions) {
    references.push(addition);
    if (references.length > FILE_SCHEMA_LIMITS.connectedEndpointsPerTarget) {
      throw new RangeError("The per-target connected-endpoint limit was exceeded.");
    }
    const continuation = slicer.checkpoint();
    if (
      continuation === "cancelled" ||
      (continuation !== "continue" && (await continuation) === "cancelled")
    )
      return "cancelled";
  }
  return Object.freeze({ references, targetId });
}

function collectConnectionChanges(
  candidate: ReplacementCandidate,
  replacement: ElementRecord,
  changes: ConnectionChanges,
): void {
  const before = connectionReferences(candidate.current.element);
  const after = connectionReferences(replacement.element);
  if (referencesEqual(before, after)) return;
  changes.changedLinearIds.add(candidate.current.element.id);
  for (const { reference, targetId } of before) {
    changes.affectedTargetIds.add(targetId);
    appendReference(changes.removals, targetId, reference);
  }
  for (const { reference, targetId } of after) {
    changes.affectedTargetIds.add(targetId);
    appendReference(changes.additions, targetId, Object.freeze(reference));
  }
}

function createConnectionChanges(): ConnectionChanges {
  return {
    additions: new Map(),
    affectedTargetIds: new Set(),
    changedLinearIds: new Set(),
    removals: new Map(),
  };
}

class ReversePatchSlicer {
  public yields = 0;
  public constructor(private readonly scheduler: StoreSliceScheduler) {}

  public cancelled(): boolean {
    return this.scheduler.isCancelled?.() ?? false;
  }

  public checkpoint(): "cancelled" | "continue" | Promise<"cancelled" | "continue"> {
    if (this.cancelled()) return "cancelled";
    if (!this.scheduler.shouldYield()) return "continue";
    return this.scheduler.yieldControl().then(() => {
      if (this.cancelled()) return "cancelled";
      this.yields += 1;
      return "continue";
    });
  }
}

function appendReference(
  buckets: Map<string, EndpointReference[]>,
  targetId: string,
  reference: EndpointReference,
): void {
  const references = buckets.get(targetId) ?? [];
  if (!buckets.has(targetId)) buckets.set(targetId, references);
  references.push(reference);
}

function assertExpectedRemovals(
  current: readonly EndpointReference[],
  removals: readonly EndpointReference[],
): void {
  const keys = new Set<string>();
  for (const reference of current) {
    const key = referenceKey(reference);
    if (keys.has(key)) throw new Error("The reverse-connection map contains duplicates.");
    keys.add(key);
  }
  for (const removal of removals) {
    if (!keys.has(referenceKey(removal))) {
      throw new Error("The reverse-connection map is inconsistent.");
    }
  }
}

function referenceKey(reference: EndpointReference): string {
  return `${reference.linearId}:${reference.endpoint}`;
}

export function commitReverseConnectionPatches(
  reverseConnections: Map<string, EndpointReference[]>,
  patches: readonly ReverseConnectionPatch[],
): void {
  for (const { references, targetId } of patches) {
    if (references.length === 0) reverseConnections.delete(targetId);
    else reverseConnections.set(targetId, references);
  }
}

function referencesEqual(
  left: ReturnType<typeof connectionReferences>,
  right: ReturnType<typeof connectionReferences>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.targetId === right[index]?.targetId &&
        value.reference.endpoint === right[index]?.reference.endpoint,
    )
  );
}
