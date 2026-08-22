import { getCanonicalStrokeReplacementProof } from "../elements/stroke-replacement-proof";
import { isWithinPageBounds, PAGE_WIDTH } from "../geometry/public";
import type { InkElementV1 } from "../schema/public";

import { createOwnedTranslatedReplacementRecord } from "./record-factory";
import { requireElementRecord } from "./record-access";
import { assertReplacementIdentity } from "./replacement-planner";
import type {
  ElementReplacementPlan,
  ElementReplacementSource,
  PreparedReplacementRecords,
} from "./time-sliced-element-replacement";
import type { ElementRecord, StoreSliceScheduler } from "./types";

const CANONICAL_TRANSLATION_DOMAINS = Object.freeze(["geometry"] as const);
const MAX_DETECTION_RECORDS_PER_SLICE = 256;
const MAX_PREPARED_RECORDS_PER_SLICE = 64;
const ATOMIC_COMMIT_ADMISSION_SIZE = 1_000;

export async function planCanonicalStrokeReplacement(
  source: ElementReplacementSource,
  replacements: readonly InkElementV1[],
  scheduler: StoreSliceScheduler,
): Promise<ElementReplacementPlan | "cancelled" | CanonicalFallback | null> {
  const detection = await detectCanonicalBatch(source, replacements, scheduler);
  if (detection === "cancelled" || detection.status === "fallback") return detection;
  const geometryVersion = nextVersion(source.geometryVersion);
  const prepared = await prepareRecords(
    source,
    replacements,
    geometryVersion,
    detection.sourceWithinPage,
    scheduler,
  );
  if (prepared === "cancelled") return prepared;
  let yields = detection.yields + prepared.yields;
  let indexYields = 0;
  const indexPatch = await source.spatialIndex.prepareReplacementsTimeSliced(
    prepared.spatialReplacements,
    {
      isCancelled: () => scheduler.isCancelled?.() ?? false,
      shouldYield: scheduler.shouldYield,
      yieldControl: async () => {
        indexYields += 1;
        await scheduler.yieldControl();
      },
    },
  );
  if (indexPatch === "cancelled") return indexPatch;
  yields += indexYields;
  const capacityPatch = source.capacity.prepare(prepared.previousRecords, prepared.records);
  const capacityCheckpoint = await yieldWhenRequested(scheduler);
  if (capacityCheckpoint === "cancelled") return capacityCheckpoint;
  yields += capacityCheckpoint;
  if (prepared.records.length >= ATOMIC_COMMIT_ADMISSION_SIZE) {
    await scheduler.yieldControl();
    if (cancelled(scheduler)) return "cancelled";
    yields += 1;
  }
  return finishPlan(source, prepared, geometryVersion, indexPatch, capacityPatch, yields);
}

export interface CanonicalFallback {
  readonly status: "fallback";
  readonly yields: number;
}

interface CanonicalDetection {
  readonly sourceWithinPage: boolean;
  readonly status: "canonical";
  readonly yields: number;
}

async function detectCanonicalBatch(
  source: ElementReplacementSource,
  replacements: readonly InkElementV1[],
  scheduler: StoreSliceScheduler,
): Promise<CanonicalDetection | "cancelled" | CanonicalFallback> {
  const ids = new Set<string>();
  let recordsInSlice = 0;
  let sourceWithinPage = true;
  let yields = 0;
  for (const replacement of replacements) {
    if (cancelled(scheduler)) return "cancelled";
    if (ids.has(replacement.id))
      throw new RangeError(`Duplicate replacement ID: ${replacement.id}`);
    ids.add(replacement.id);
    const current = requireElementRecord(source.records, replacement.id);
    if (current.element.kind !== "stroke" || replacement.kind !== "stroke") {
      return { status: "fallback", yields };
    }
    const proof = getCanonicalStrokeReplacementProof(replacement);
    if (proof?.source !== current.element) return { status: "fallback", yields };
    assertReplacementIdentity(current.element, replacement);
    sourceWithinPage &&= isWithinPageBounds(current.bounds);
    recordsInSlice += 1;
    const checkpoint = await yieldWhenRequested(
      scheduler,
      recordsInSlice >= MAX_DETECTION_RECORDS_PER_SLICE,
    );
    if (checkpoint === "cancelled") return checkpoint;
    if (checkpoint === 1) recordsInSlice = 0;
    yields += checkpoint;
  }
  return { sourceWithinPage, status: "canonical", yields };
}

async function prepareRecords(
  source: ElementReplacementSource,
  replacements: readonly InkElementV1[],
  geometryVersion: number,
  enforcePageBounds: boolean,
  scheduler: StoreSliceScheduler,
): Promise<PreparedReplacementRecords | "cancelled"> {
  const prepared: PreparedReplacementRecords = {
    changes: [],
    previousRecords: [],
    records: [],
    spatialReplacements: [],
    yields: 0,
  };
  let recordsInSlice = 0;
  let yields = 0;
  for (const replacement of replacements) {
    if (cancelled(scheduler)) return "cancelled";
    const current = requireElementRecord(source.records, replacement.id);
    const proof = getCanonicalStrokeReplacementProof(replacement)!;
    if (proof.translation.x === 0 && proof.translation.y === 0) continue;
    if (enforcePageBounds && !translatedBoundsWithinPage(current, proof.translation)) {
      throw new RangeError("Conservative element bounds must remain within the supported page.");
    }
    const record = createOwnedTranslatedReplacementRecord(
      replacement,
      current,
      geometryVersion,
      current.paintVersion,
      proof.translation,
    );
    prepared.previousRecords.push(current);
    prepared.records.push(record);
    prepared.spatialReplacements.push({ bounds: record.bounds, id: record.element.id });
    prepared.changes.push(
      Object.freeze({
        after: record,
        before: current,
        domains: CANONICAL_TRANSLATION_DOMAINS,
        id: record.element.id,
      }),
    );
    recordsInSlice += 1;
    const checkpoint = await yieldWhenRequested(
      scheduler,
      recordsInSlice >= MAX_PREPARED_RECORDS_PER_SLICE,
    );
    if (checkpoint === "cancelled") return checkpoint;
    if (checkpoint === 1) recordsInSlice = 0;
    yields += checkpoint;
  }
  return { ...prepared, yields };
}

function translatedBoundsWithinPage(
  current: ElementRecord,
  translation: Readonly<{ x: number; y: number }>,
): boolean {
  return (
    current.bounds.minX + translation.x >= 0 &&
    current.bounds.maxX + translation.x <= PAGE_WIDTH &&
    current.bounds.minY + translation.y >= 0
  );
}

function finishPlan(
  source: ElementReplacementSource,
  prepared: PreparedReplacementRecords,
  geometryVersion: number,
  indexPatch: ElementReplacementPlan["indexPatch"],
  capacityPatch: ElementReplacementPlan["capacityPatch"],
  yields: number,
): ElementReplacementPlan | null {
  if (prepared.changes.length === 0) return null;
  return {
    capacityPatch,
    delta: Object.freeze({
      changes: Object.freeze(prepared.changes),
      dirtyBands: Object.freeze({ content: false, highlight: false }),
      geometryVersion,
      paintVersion: source.paintVersion,
    }),
    geometryVersion,
    indexPatch,
    indexVisitCount: prepared.records.length,
    paintVersion: source.paintVersion,
    records: Object.freeze(prepared.records),
    replacementCount: prepared.records.length,
    reversePatches: Object.freeze([]),
    yields,
  };
}

async function yieldWhenRequested(
  scheduler: StoreSliceScheduler,
  required = false,
): Promise<0 | 1 | "cancelled"> {
  if (cancelled(scheduler)) return "cancelled";
  if (!required && !scheduler.shouldYield()) return 0;
  await scheduler.yieldControl();
  return cancelled(scheduler) ? "cancelled" : 1;
}

function cancelled(scheduler: StoreSliceScheduler): boolean {
  return scheduler.isCancelled?.() ?? false;
}

function nextVersion(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("geometryVersion reached Number.MAX_SAFE_INTEGER.");
  }
  return value + 1;
}
