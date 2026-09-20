import type { ElementStoreOrdering } from "./order-operations";
import type { UniformSpatialIndex } from "../spatial/index";

import {
  addConnectionReferences,
  isAnchorTarget,
  prepareConnectionDetachments,
  removeConnectionReferences,
} from "./connections";
import { DeltaBuilder } from "./delta-builder";
import { DocumentCapacity } from "./document-capacity";
import { hasConnections } from "./element-comparison";
import { normalizeIdInput } from "./input-normalization";
import {
  assertOverflowCapacity,
  createReplacementRecord,
  isOverflowBounds,
  nextRecordVersion,
} from "./record-factory";
import { requireElementRecord } from "./record-access";
import type { DeltaDomain, ElementRecord, EndpointReference, StoreDelta } from "./types";
import type { MutableStoreInstrumentation } from "./instrumentation";

interface RemovalState {
  readonly ordering: ElementStoreOrdering;
  readonly capacity: DocumentCapacity;
  readonly geometryVersion: number;
  readonly instrumentation: MutableStoreInstrumentation;
  readonly overflowCount: number;
  readonly paintVersion: number;
  readonly records: Map<string, ElementRecord>;
  readonly reverseConnections: Map<string, EndpointReference[]>;
  readonly spatialIndex: UniformSpatialIndex<string>;
}

export interface RemovalResult {
  readonly delta: StoreDelta;
  readonly geometryVersion: number;
  readonly overflowDelta: number;
}

export function removeElements(
  state: RemovalState,
  values: ReadonlySet<string> | readonly string[],
): RemovalResult | null {
  const removedIds = new Set([...normalizeIdInput(values)].filter((id) => state.records.has(id)));
  if (removedIds.size === 0) return null;
  const detached = prepareConnectionDetachments(
    removedIds,
    state.reverseConnections,
    (id) => requireElementRecord(state.records, id).element,
    () => {
      state.instrumentation.reverseDependencyVisits += 1;
    },
  );
  const geometryVersion =
    detached.size === 0
      ? state.geometryVersion
      : nextRecordVersion(state.geometryVersion, "geometryVersion");
  const detachedRecords = [...detached].map(([id, element]) => {
    const current = requireElementRecord(state.records, id);
    return createReplacementRecord(element, current, geometryVersion, current.paintVersion);
  });
  assertOverflowCapacity(
    state.overflowCount,
    detachedRecords.map((record) => requireElementRecord(state.records, record.element.id)),
    detachedRecords,
    [...removedIds].map((id) => requireElementRecord(state.records, id)),
  );
  const removedRecords = [...removedIds].map((id) => requireElementRecord(state.records, id));
  const detachedPrevious = detachedRecords.map((record) =>
    requireElementRecord(state.records, record.element.id),
  );
  const capacityPatch = state.capacity.prepare(
    [...detachedPrevious, ...removedRecords],
    detachedRecords,
  );
  const indexPatch = state.spatialIndex.prepareReplacements(
    detachedRecords.map(({ bounds, element }) => ({ bounds, id: element.id })),
  );
  state.capacity.commit(capacityPatch);
  state.spatialIndex.commitPreparedReplacements(indexPatch);
  const delta = new DeltaBuilder();
  let overflowDelta = 0;
  for (const record of detachedRecords) {
    const current = requireElementRecord(state.records, record.element.id);
    replaceRecord(state, current, record);
    overflowDelta +=
      Number(isOverflowBounds(record.bounds)) - Number(isOverflowBounds(current.bounds));
    delta.add(record.element.id, current, record, ["geometry", "connection"]);
  }
  for (const id of removedIds) overflowDelta += removeRecord(state, id, delta);
  removeBandIds(state, removedIds);
  return {
    delta: delta.build(geometryVersion, state.paintVersion)!,
    geometryVersion,
    overflowDelta,
  };
}

function replaceRecord(
  state: RemovalState,
  current: ElementRecord,
  replacement: ElementRecord,
): void {
  removeConnectionReferences(state.reverseConnections, current.element);
  state.records.set(replacement.element.id, replacement);
  addConnectionReferences(state.reverseConnections, replacement.element);
  state.instrumentation.recordReplacements += 1;
}

function removeRecord(state: RemovalState, id: string, delta: DeltaBuilder): number {
  const current = requireElementRecord(state.records, id);
  removeConnectionReferences(state.reverseConnections, current.element);
  state.reverseConnections.delete(id);
  state.records.delete(id);
  state.spatialIndex.remove(id);
  const domains: DeltaDomain[] = ["order", "visibility"];
  if (hasConnections(current.element) || isAnchorTarget(current.element))
    domains.push("connection");
  delta.add(id, current, null, domains);
  return -Number(isOverflowBounds(current.bounds));
}

function removeBandIds(state: RemovalState, removedIds: ReadonlySet<string>): void {
  for (const id of removedIds) state.ordering.remove(id);
}
