import type { UniformSpatialIndex } from "../spatial/index";

import { DeltaBuilder } from "./delta-builder";
import type { DocumentCapacity } from "./document-capacity";
import {
  createReplacementRecord,
  createOwnedTranslatedReplacementRecord,
  nextRecordVersion,
} from "./record-factory";
import { getCanonicalStrokeReplacementProof } from "../elements/stroke-replacement-proof";
import {
  commitReverseConnectionPatches,
  createReverseConnectionPatches,
} from "./replacement-reverse-patch";
import type { ReplacementCandidate } from "./replacement-planner";
import type { ElementRecord, EndpointReference, StoreDelta } from "./types";

interface ReplacementState {
  readonly capacity: DocumentCapacity;
  readonly geometryVersion: number;
  readonly paintVersion: number;
  readonly records: Map<string, ElementRecord>;
  readonly reverseConnections: Map<string, EndpointReference[]>;
  readonly spatialIndex: UniformSpatialIndex<string>;
}

export interface SynchronousReplacementResult {
  readonly delta: StoreDelta;
  readonly geometryVersion: number;
  readonly overflowCount: number;
  readonly paintVersion: number;
  readonly replacementCount: number;
}

export function commitSynchronousReplacements(
  state: ReplacementState,
  candidates: readonly ReplacementCandidate[],
): SynchronousReplacementResult {
  const changesGeometry = candidates.some(({ domains }) => domains.includes("geometry"));
  const changesPaint = candidates.some(({ domains }) => domains.includes("paint"));
  const geometryVersion = changesGeometry
    ? nextRecordVersion(state.geometryVersion, "geometryVersion")
    : state.geometryVersion;
  const paintVersion = changesPaint
    ? nextRecordVersion(state.paintVersion, "paintVersion")
    : state.paintVersion;
  const records = candidates.map(({ current, domains, element }) =>
    replacementRecord(
      element,
      current,
      domains.includes("geometry") ? geometryVersion : current.geometryVersion,
      domains.includes("paint") ? paintVersion : current.paintVersion,
    ),
  );
  const capacityPatch = state.capacity.prepare(
    candidates.map(({ current }) => current),
    records,
  );
  const indexPatch = state.spatialIndex.prepareReplacements(
    records
      .filter((_, index) => candidates[index]?.domains.includes("geometry"))
      .map(({ bounds, element }) => ({ bounds, id: element.id })),
  );
  const reversePatches = createReverseConnectionPatches(
    state.reverseConnections,
    candidates,
    records,
  );

  state.capacity.commit(capacityPatch);
  state.spatialIndex.commitPreparedReplacements(indexPatch);
  const delta = new DeltaBuilder();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const record = records[index]!;
    state.records.set(record.element.id, record);
    delta.add(record.element.id, candidate.current, record, candidate.domains);
  }
  commitReverseConnectionPatches(state.reverseConnections, reversePatches);
  return {
    delta: delta.build(geometryVersion, paintVersion)!,
    geometryVersion,
    overflowCount: state.spatialIndex.overflowCount,
    paintVersion,
    replacementCount: candidates.length,
  };
}

function replacementRecord(
  element: ReplacementCandidate["element"],
  current: ElementRecord,
  geometryVersion: number,
  paintVersion: number,
): ElementRecord {
  const proof = getCanonicalStrokeReplacementProof(element);
  return proof?.source === current.element
    ? createOwnedTranslatedReplacementRecord(
        element,
        current,
        geometryVersion,
        paintVersion,
        proof.translation,
      )
    : createReplacementRecord(element, current, geometryVersion, paintVersion);
}
