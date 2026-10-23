import {
  getCanonicalStrokeReplacementProof,
  type CanonicalStrokeReplacementProof,
} from "../../elements/stroke-replacement-proof";
import type { InkElementV1 } from "../../schema/public";
import { UniformSpatialIndex } from "../../spatial/index";

import {
  commitReverseConnectionPatches,
  createReverseConnectionPatchesTimeSliced,
  type ReverseConnectionPatch,
} from "./replacement-reverse-patch";
import { planCanonicalStrokeReplacement } from "./canonical-stroke-replacement";
import { DocumentCapacity, type DocumentCapacityPatch } from "../records/document-capacity";
import {
  createOwnedReplacementRecordSteps,
  createOwnedTranslatedReplacementRecord,
} from "../records/record-factory";
import { requireElementRecord } from "../records/record-access";
import { MutationPreparationScheduler } from "../mutations/mutation-preparation-scheduler";
import { restoreOwnedRecordSteps } from "../mutations/owned-mutation-history";
import type { ReplacementHistory } from "./replacement-history";
import { cancelled, ReplacementCheckpoint, yieldWhenRequested } from "./replacement-scheduler";
import {
  prepareReplacementCandidatesTimeSliced,
  type ReplacementCandidate,
  type ReplacementPlannerPorts,
} from "./replacement-planner";
import type {
  ElementReplacementPlan,
  ElementReplacementSource,
  PreparedReplacementRecords,
} from "./replacement-types";
import type {
  ElementRecord,
  EndpointReference,
  ImmutableInkElement,
  StoreSliceScheduler,
} from "../types";

interface PreparedCandidateRecords extends PreparedReplacementRecords {
  readonly connectionCandidates: ReplacementCandidate[];
  readonly connectionRecords: ElementRecord[];
  readonly geometryVersion: number;
  readonly paintVersion: number;
}

export async function planElementReplacement(
  source: ElementReplacementSource,
  replacements: readonly InkElementV1[],
  scheduler: StoreSliceScheduler,
): Promise<ElementReplacementPlan | "cancelled" | null> {
  if (cancelled(scheduler)) return "cancelled";
  const canonical = await planCanonicalStrokeReplacement(source, replacements, scheduler);
  if (canonical === "cancelled" || canonical === null || !("status" in canonical)) return canonical;
  const fallbackYields = canonical.yields;
  let reverseVisits = 0;
  const ports: ReplacementPlannerPorts = {
    getRecord: (id) => requireElementRecord(source.records, id),
    getReferences: (id) => source.reverseConnections.get(id),
    onReverseVisit: () => {
      reverseVisits += 1;
    },
    getRetainedRecord: (element) => source.history.retainedRecord(element),
  };
  const preparedCandidates = await prepareReplacementCandidatesTimeSliced(
    replacements,
    ports,
    scheduler,
  );
  if (preparedCandidates === "cancelled") return preparedCandidates;
  const candidates = preparedCandidates.candidates;
  let yields = fallbackYields + preparedCandidates.yields;
  if (candidates.length === 0) return null;

  const preparedRecords = await prepareCandidateRecords(
    candidates,
    source.geometryVersion,
    source.paintVersion,
    source.capacity,
    scheduler,
    source.history,
  );
  if (preparedRecords === "cancelled") return preparedRecords;
  const {
    capacityPreviousRecords,
    capacityRecords,
    changes,
    connectionCandidates,
    connectionRecords,
    geometryVersion: nextGeometryVersion,
    history,
    paintVersion: nextPaintVersion,
    records,
    spatialReplacements,
  } = preparedRecords;
  yields += preparedRecords.yields;

  let indexYields = 0;
  const indexPatch = await source.spatialIndex.prepareReplacementsTimeSliced(spatialReplacements, {
    isCancelled: () => scheduler.isCancelled?.() ?? false,
    shouldYield: scheduler.shouldYield,
    yieldControl: async () => {
      indexYields += 1;
      await scheduler.yieldControl();
    },
  });
  if (indexPatch === "cancelled") return indexPatch;
  yields += indexYields;
  const dependentPatches = await prepareDependentPatches(
    source,
    { capacityPreviousRecords, capacityRecords, connectionCandidates, connectionRecords },
    scheduler,
  );
  if (dependentPatches === "cancelled") return dependentPatches;
  yields += dependentPatches.yields;
  const admissionCheckpoint = yieldWhenRequested(scheduler);
  const admission =
    admissionCheckpoint === 0 || admissionCheckpoint === "cancelled"
      ? admissionCheckpoint
      : await admissionCheckpoint;
  if (admission === "cancelled") return admission;
  yields += admission;
  Object.freeze(changes);
  return {
    capacityPatch: dependentPatches.capacityPatch,
    delta: Object.freeze({
      changes,
      dirtyBands: Object.freeze({ content: false, highlight: false }),
      geometryVersion: nextGeometryVersion,
      paintVersion: nextPaintVersion,
    }),
    geometryVersion: nextGeometryVersion,
    history,
    indexPatch,
    indexVisitCount: spatialReplacements.length + reverseVisits,
    paintVersion: nextPaintVersion,
    records: Object.freeze(records),
    replacementCount: candidates.length,
    reversePatches: dependentPatches.reversePatches,
    yields,
  };
}

async function prepareDependentPatches(
  source: ElementReplacementSource,
  prepared: Pick<
    PreparedCandidateRecords,
    "capacityPreviousRecords" | "capacityRecords" | "connectionCandidates" | "connectionRecords"
  >,
  scheduler: StoreSliceScheduler,
): Promise<
  | {
      readonly capacityPatch: DocumentCapacityPatch;
      readonly reversePatches: readonly ReverseConnectionPatch[];
      readonly yields: number;
    }
  | "cancelled"
> {
  const reverse =
    prepared.connectionCandidates.length === 0
      ? { patches: Object.freeze([]), yields: 0 }
      : await createReverseConnectionPatchesTimeSliced(
          source.reverseConnections,
          prepared.connectionCandidates,
          prepared.connectionRecords,
          scheduler,
        );
  if (reverse === "cancelled") return reverse;
  const capacity =
    prepared.capacityRecords.length === 0
      ? { patch: source.capacity.prepareUnchanged(), yields: 0 }
      : await source.capacity.prepareTimeSliced(
          prepared.capacityPreviousRecords,
          prepared.capacityRecords,
          scheduler,
        );
  if (capacity === "cancelled") return capacity;
  return {
    capacityPatch: capacity.patch,
    reversePatches: reverse.patches,
    yields: reverse.yields + capacity.yields,
  };
}

async function prepareCandidateRecords(
  candidates: readonly ReplacementCandidate[],
  currentGeometryVersion: number,
  currentPaintVersion: number,
  capacity: DocumentCapacity,
  scheduler: StoreSliceScheduler,
  history: ReplacementHistory,
): Promise<PreparedCandidateRecords | "cancelled"> {
  const records: ElementRecord[] = [];
  const capacityPreviousRecords: ElementRecord[] = [];
  const capacityRecords: ElementRecord[] = [];
  const connectionCandidates: ReplacementCandidate[] = [];
  const connectionRecords: ElementRecord[] = [];
  const spatialReplacements: PreparedReplacementRecords["spatialReplacements"] = [];
  const changes: PreparedReplacementRecords["changes"] = [];
  let geometryVersion = currentGeometryVersion;
  let paintVersion = currentPaintVersion;
  const historyBuilder = history.createBuilder();
  let recordYields = 0;
  const trackedScheduler: StoreSliceScheduler = {
    ...scheduler,
    yieldControl: async () => {
      await scheduler.yieldControl();
      recordYields += 1;
    },
  };
  const work = new ReplacementCheckpoint(trackedScheduler);
  const recordWork = new MutationPreparationScheduler(trackedScheduler);
  for (const candidate of candidates) {
    if (cancelled(scheduler)) return "cancelled";
    if (candidate.domains.includes("geometry") && geometryVersion === currentGeometryVersion) {
      geometryVersion = nextVersion(currentGeometryVersion, "geometryVersion");
    }
    if (candidate.domains.includes("paint") && paintVersion === currentPaintVersion) {
      paintVersion = nextVersion(currentPaintVersion, "paintVersion");
    }
    const preparation = createCandidateRecord(candidate, geometryVersion, paintVersion, recordWork);
    const record = preparation instanceof Promise ? await preparation : preparation;
    if (record === "cancelled") return record;
    records.push(record);
    historyBuilder.append(candidate.current, record);
    if (candidate.domains.includes("geometry")) {
      capacity.validateReplacementBounds(record);
      spatialReplacements.push({ bounds: record.bounds, id: record.element.id });
    }
    if (changesCapacity(candidate, record)) {
      capacityPreviousRecords.push(candidate.current);
      capacityRecords.push(record);
    }
    if (candidate.domains.includes("connection")) {
      connectionCandidates.push(candidate);
      connectionRecords.push(record);
    }
    changes.push(
      Object.freeze({
        after: record,
        before: candidate.current,
        domains: candidate.domains,
        id: record.element.id,
      }),
    );
    const checkpoint = work.checkpoint();
    if (checkpoint === false || (checkpoint !== true && !(await checkpoint))) return "cancelled";
  }
  return {
    capacityPreviousRecords,
    capacityRecords,
    changes,
    connectionCandidates,
    connectionRecords,
    geometryVersion,
    history: historyBuilder.finish(),
    paintVersion,
    records,
    spatialReplacements,
    yields: recordYields,
  };
}

function changesCapacity(candidate: ReplacementCandidate, record: ElementRecord): boolean {
  if (candidate.domains.includes("connection")) return true;
  return (
    candidate.current.element.kind === "stroke" &&
    record.element.kind === "stroke" &&
    candidate.current.element.points.length !== record.element.points.length
  );
}

export function commitReplacementPlan(
  capacity: DocumentCapacity,
  records: Map<string, ElementRecord>,
  reverseConnections: Map<string, EndpointReference[]>,
  spatialIndex: UniformSpatialIndex<string>,
  plan: ElementReplacementPlan,
): void {
  capacity.commit(plan.capacityPatch);
  spatialIndex.commitPreparedReplacements(plan.indexPatch);
  for (const record of plan.records) records.set(record.element.id, record);
  commitReverseConnectionPatches(reverseConnections, plan.reversePatches);
}

function createCandidateRecord(
  candidate: ReplacementCandidate,
  geometryVersion: number,
  paintVersion: number,
  work: MutationPreparationScheduler,
): ElementRecord | "cancelled" | Promise<ElementRecord | "cancelled"> {
  return work.run(createCandidateRecordSteps(candidate, geometryVersion, paintVersion));
}

function* createCandidateRecordSteps(
  candidate: ReplacementCandidate,
  geometryVersion: number,
  paintVersion: number,
): Generator<void | boolean, ElementRecord> {
  const nextGeometryVersion = candidate.domains.includes("geometry")
    ? geometryVersion
    : candidate.current.geometryVersion;
  const nextPaintVersion = candidate.domains.includes("paint")
    ? paintVersion
    : candidate.current.paintVersion;
  const restored = yield* restoreOwnedRecordSteps(
    candidate.element,
    candidate.current,
    candidate.retainedRecord,
    {
      geometryVersion: nextGeometryVersion,
      paintVersion: nextPaintVersion,
    },
  );
  if (restored !== undefined) return restored;
  const translation = canonicalStrokeTranslation(candidate.current.element, candidate.element);
  if (translation !== null) {
    return createOwnedTranslatedReplacementRecord(
      candidate.element,
      candidate.current,
      nextGeometryVersion,
      nextPaintVersion,
      translation,
    );
  }
  yield;
  return yield* createOwnedReplacementRecordSteps(
    candidate.element,
    candidate.current,
    nextGeometryVersion,
    nextPaintVersion,
  );
}

function canonicalStrokeTranslation(
  current: ImmutableInkElement,
  replacement: InkElementV1,
): CanonicalStrokeReplacementProof["translation"] | null {
  if (current.kind !== "stroke" || replacement.kind !== "stroke") return null;
  const proof = getCanonicalStrokeReplacementProof(replacement);
  return proof?.source === current ? proof.translation : null;
}

function nextVersion(value: number, name: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} reached Number.MAX_SAFE_INTEGER.`);
  }
  return value + 1;
}
