import {
  getCanonicalStrokeReplacementProof,
  type CanonicalStrokeReplacementProof,
} from "../elements/stroke-replacement-proof";
import type { InkElementV1 } from "../schema/public";
import { UniformSpatialIndex } from "../spatial/index";

import {
  commitReverseConnectionPatches,
  createReverseConnectionPatchesTimeSliced,
  type ReverseConnectionPatch,
} from "./replacement-reverse-patch";
import { planCanonicalStrokeReplacement } from "./canonical-stroke-replacement";
import { DocumentCapacity, type DocumentCapacityPatch } from "./document-capacity";
import {
  createOwnedReplacementRecord,
  createOwnedTranslatedReplacementRecord,
} from "./record-factory";
import { requireElementRecord } from "./record-access";
import {
  prepareReplacementCandidatesTimeSliced,
  type ReplacementCandidate,
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
} from "./types";

const ATOMIC_COMMIT_ADMISSION_SIZE = 1_000;
const MAX_RECORDS_PER_PREPARATION_SLICE = 256;

interface ReplacementPorts {
  readonly getRecord: (id: string) => ElementRecord;
  readonly getReferences: (targetId: string) => readonly EndpointReference[] | undefined;
  readonly onReverseVisit: () => void;
}

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
  const ports: ReplacementPorts = {
    getRecord: (id) => requireElementRecord(source.records, id),
    getReferences: (id) => source.reverseConnections.get(id),
    onReverseVisit: () => {
      reverseVisits += 1;
    },
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
  );
  if (preparedRecords === "cancelled") return preparedRecords;
  const {
    capacityPreviousRecords,
    capacityRecords,
    changes,
    connectionCandidates,
    connectionRecords,
    geometryVersion: nextGeometryVersion,
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
  const admission = await admitAtomicCommit(candidates.length, scheduler);
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
  let recordsInSlice = 0;
  let yields = 0;
  for (const candidate of candidates) {
    if (cancelled(scheduler)) return "cancelled";
    if (candidate.domains.includes("geometry") && geometryVersion === currentGeometryVersion) {
      geometryVersion = nextVersion(currentGeometryVersion, "geometryVersion");
    }
    if (candidate.domains.includes("paint") && paintVersion === currentPaintVersion) {
      paintVersion = nextVersion(currentPaintVersion, "paintVersion");
    }
    const record = createCandidateRecord(candidate, geometryVersion, paintVersion);
    records.push(record);
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
    recordsInSlice += 1;
    const checkpoint = await yieldWhenRequested(
      scheduler,
      recordsInSlice >= MAX_RECORDS_PER_PREPARATION_SLICE,
    );
    if (checkpoint === "cancelled") return checkpoint;
    if (checkpoint === 1) recordsInSlice = 0;
    yields += checkpoint;
  }
  return {
    capacityPreviousRecords,
    capacityRecords,
    changes,
    connectionCandidates,
    connectionRecords,
    geometryVersion,
    paintVersion,
    records,
    spatialReplacements,
    yields,
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

async function admitAtomicCommit(
  replacementCount: number,
  scheduler: StoreSliceScheduler,
): Promise<0 | 1 | "cancelled"> {
  if (replacementCount < ATOMIC_COMMIT_ADMISSION_SIZE) return 0;
  await scheduler.yieldControl();
  return cancelled(scheduler) ? "cancelled" : 1;
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
): ElementRecord {
  const nextGeometryVersion = candidate.domains.includes("geometry")
    ? geometryVersion
    : candidate.current.geometryVersion;
  const nextPaintVersion = candidate.domains.includes("paint")
    ? paintVersion
    : candidate.current.paintVersion;
  const translation = canonicalStrokeTranslation(candidate.current.element, candidate.element);
  return translation === null
    ? createOwnedReplacementRecord(
        candidate.element,
        candidate.current,
        nextGeometryVersion,
        nextPaintVersion,
      )
    : createOwnedTranslatedReplacementRecord(
        candidate.element,
        candidate.current,
        nextGeometryVersion,
        nextPaintVersion,
        translation,
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

async function yieldWhenRequested(
  scheduler: StoreSliceScheduler,
  required = false,
): Promise<number | "cancelled"> {
  const alreadyCancelled = cancelled(scheduler);
  if (alreadyCancelled) return "cancelled";
  const shouldYield = required || scheduler.shouldYield();
  if (!shouldYield) return 0;
  await scheduler.yieldControl();
  return cancelled(scheduler) ? "cancelled" : 1;
}

function cancelled(scheduler: StoreSliceScheduler): boolean {
  return scheduler.isCancelled?.() ?? false;
}

function nextVersion(value: number, name: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} reached Number.MAX_SAFE_INTEGER.`);
  }
  return value + 1;
}
