import { FILE_SCHEMA_LIMITS } from "../schema/constants";

import { connectionReferences } from "./connections";
import type { ReplacementCandidate } from "./replacement-planner";
import type { ElementRecord, EndpointReference } from "./types";

export interface ReverseConnectionPatch {
  readonly references: EndpointReference[];
  readonly targetId: string;
}

export function createReverseConnectionPatches(
  source: ReadonlyMap<string, readonly EndpointReference[]>,
  candidates: readonly ReplacementCandidate[],
  replacements: readonly ElementRecord[],
): readonly ReverseConnectionPatch[] {
  const changedLinearIds = new Set<string>();
  const affectedTargetIds = new Set<string>();
  const additions = new Map<string, EndpointReference[]>();
  const removals = new Map<string, EndpointReference[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    const before = connectionReferences(candidates[index]!.current.element);
    const after = connectionReferences(replacements[index]!.element);
    if (referencesEqual(before, after)) continue;
    changedLinearIds.add(candidates[index]!.current.element.id);
    for (const { reference, targetId } of before) {
      affectedTargetIds.add(targetId);
      appendReference(removals, targetId, reference);
    }
    for (const { reference, targetId } of after) {
      affectedTargetIds.add(targetId);
      appendReference(additions, targetId, Object.freeze(reference));
    }
  }

  const patches: ReverseConnectionPatch[] = [];
  for (const targetId of affectedTargetIds) {
    const current = source.get(targetId) ?? [];
    assertExpectedRemovals(current, removals.get(targetId) ?? []);
    const references = current.filter(({ linearId }) => !changedLinearIds.has(linearId));
    references.push(...(additions.get(targetId) ?? []));
    if (references.length > FILE_SCHEMA_LIMITS.connectedEndpointsPerTarget) {
      throw new RangeError("The per-target connected-endpoint limit was exceeded.");
    }
    patches.push(Object.freeze({ references, targetId }));
  }
  return Object.freeze(patches);
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
