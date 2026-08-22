import {
  getCanonicalStrokeReplacementProof,
  type CanonicalStrokeReplacementProof,
} from "../elements/stroke-replacement-proof";
import type { InkElementV1 } from "../schema/public";
import { type PreparedSpatialReplacements, UniformSpatialIndex } from "../spatial/index";

import {
  commitReverseConnectionPatches,
  createReverseConnectionPatches,
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
  ElementRecord,
  EndpointReference,
  ImmutableInkElement,
  StoreDelta,
  StoreSliceScheduler,
} from "./types";

const ATOMIC_COMMIT_ADMISSION_SIZE = 1_000;
const MAX_RECORDS_PER_PREPARATION_SLICE = 256;

export interface ElementReplacementPlan {
  readonly capacityPatch: DocumentCapacityPatch;
  readonly delta: StoreDelta;
  readonly geometryVersion: number;
  readonly indexPatch: PreparedSpatialReplacements<string>;
  readonly indexVisitCount: number;
  readonly paintVersion: number;
  readonly records: readonly ElementRecord[];
  readonly replacementCount: number;
  readonly reversePatches: readonly ReverseConnectionPatch[];
  readonly yields: number;
}

interface ReplacementPorts {
  readonly getRecord: (id: string) => ElementRecord;
  readonly getReferences: (targetId: string) => readonly EndpointReference[] | undefined;
  readonly onReverseVisit: () => void;
}

export interface PreparedReplacementRecords {
  readonly changes: Array<StoreDelta["changes"][number]>;
  readonly previousRecords: ElementRecord[];
  readonly records: ElementRecord[];
  readonly spatialReplacements: Array<{ bounds: ElementRecord["bounds"]; id: string }>;
  readonly yields: number;
}

export interface ElementReplacementSource {
  readonly capacity: DocumentCapacity;
  readonly geometryVersion: number;
  readonly paintVersion: number;
  readonly records: ReadonlyMap<string, ElementRecord>;
  readonly reverseConnections: ReadonlyMap<string, readonly EndpointReference[]>;
  readonly spatialIndex: UniformSpatialIndex<string>;
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

  const changesGeometry = candidates.some(({ domains }) => domains.includes("geometry"));
  const changesPaint = candidates.some(({ domains }) => domains.includes("paint"));
  const nextGeometryVersion = changesGeometry
    ? nextVersion(source.geometryVersion, "geometryVersion")
    : source.geometryVersion;
  const nextPaintVersion = changesPaint
    ? nextVersion(source.paintVersion, "paintVersion")
    : source.paintVersion;
  const preparedRecords = await prepareCandidateRecords(
    candidates,
    nextGeometryVersion,
    nextPaintVersion,
    scheduler,
  );
  if (preparedRecords === "cancelled") return preparedRecords;
  const { changes, previousRecords, records, spatialReplacements } = preparedRecords;
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
  const reversePatches = createReverseConnectionPatches(
    source.reverseConnections,
    candidates,
    records,
  );
  const capacityPatch = source.capacity.prepare(previousRecords, records);
  const patchCheckpoint = await yieldWhenRequested(scheduler);
  if (patchCheckpoint === "cancelled") return patchCheckpoint;
  yields += patchCheckpoint;
  const admission = await admitAtomicCommit(candidates.length, scheduler);
  if (admission === "cancelled") return admission;
  yields += admission;
  Object.freeze(changes);
  return {
    capacityPatch,
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
    reversePatches,
    yields,
  };
}

async function prepareCandidateRecords(
  candidates: readonly ReplacementCandidate[],
  geometryVersion: number,
  paintVersion: number,
  scheduler: StoreSliceScheduler,
): Promise<PreparedReplacementRecords | "cancelled"> {
  const previousRecords: ElementRecord[] = [];
  const records: ElementRecord[] = [];
  const spatialReplacements: PreparedReplacementRecords["spatialReplacements"] = [];
  const changes: PreparedReplacementRecords["changes"] = [];
  let recordsInSlice = 0;
  let yields = 0;
  for (const candidate of candidates) {
    if (cancelled(scheduler)) return "cancelled";
    const record = createCandidateRecord(candidate, geometryVersion, paintVersion);
    previousRecords.push(candidate.current);
    records.push(record);
    if (candidate.domains.includes("geometry")) {
      spatialReplacements.push({ bounds: record.bounds, id: record.element.id });
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
  return { changes, previousRecords, records, spatialReplacements, yields };
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
