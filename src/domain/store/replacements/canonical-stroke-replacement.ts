import {
  getCanonicalStrokeReplacementProof,
  inferStoredStrokeTranslation,
} from "../../elements/stroke-replacement-proof";
import type { InkElementV1 } from "../../schema/public";

import { createOwnedTranslatedReplacementRecord } from "../records/record-factory";
import { requireElementRecord } from "../records/record-access";
import { assertReplacementIdentity } from "./replacement-planner";
import { cancelled, ReplacementCheckpoint, yieldWhenRequested } from "./replacement-scheduler";
import type {
  ElementReplacementPlan,
  ElementReplacementSource,
  PreparedReplacementRecords,
} from "./replacement-types";
import type { StoreSliceScheduler } from "../types";

const CANONICAL_TRANSLATION_DOMAINS = Object.freeze(["geometry"] as const);

export async function planCanonicalStrokeReplacement(
  source: ElementReplacementSource,
  replacements: readonly InkElementV1[],
  scheduler: StoreSliceScheduler,
): Promise<ElementReplacementPlan | "cancelled" | CanonicalFallback | null> {
  const detection = await detectCanonicalBatch(source, replacements, scheduler);
  if (detection === "cancelled" || detection.status === "fallback") return detection;
  const geometryVersion = nextVersion(source.geometryVersion);
  const prepared = await prepareRecords(source, detection.replacements, geometryVersion, scheduler);
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
  const capacityPatch = source.capacity.prepareUnchanged();
  const admissionCheckpoint = yieldWhenRequested(scheduler);
  const admission =
    admissionCheckpoint === 0 || admissionCheckpoint === "cancelled"
      ? admissionCheckpoint
      : await admissionCheckpoint;
  if (admission === "cancelled") return admission;
  yields += admission;
  return finishPlan(source, prepared, geometryVersion, indexPatch, capacityPatch, yields);
}

export interface CanonicalFallback {
  readonly status: "fallback";
  readonly yields: number;
}

interface CanonicalDetection {
  readonly status: "canonical";
  readonly yields: number;
  readonly replacements: readonly InkElementV1[];
}

async function detectCanonicalBatch(
  source: ElementReplacementSource,
  replacements: readonly InkElementV1[],
  scheduler: StoreSliceScheduler,
): Promise<CanonicalDetection | "cancelled" | CanonicalFallback> {
  const ids = new Set<string>();
  const staged: InkElementV1[] = [];
  const work = new ReplacementCheckpoint(scheduler);
  for (const replacement of replacements) {
    if (cancelled(scheduler)) return "cancelled";
    if (source.history.retainedRecord(replacement) !== undefined) {
      return { status: "fallback", yields: work.yields };
    }
    if (ids.has(replacement.id))
      throw new RangeError(`Duplicate replacement ID: ${replacement.id}`);
    ids.add(replacement.id);
    const current = requireElementRecord(source.records, replacement.id);
    if (current.element.kind !== "stroke" || replacement.kind !== "stroke") {
      return { status: "fallback", yields: work.yields };
    }
    const proof = inferStoredStrokeTranslation(current.element, replacement);
    if (proof?.source !== current.element) return { status: "fallback", yields: work.yields };
    assertReplacementIdentity(current.element, replacement);
    staged.push(replacement);
    const checkpoint = work.checkpoint();
    if (checkpoint === false || (checkpoint !== true && !(await checkpoint))) return "cancelled";
  }
  return { status: "canonical", yields: work.yields, replacements: Object.freeze(staged) };
}

async function prepareRecords(
  source: ElementReplacementSource,
  replacements: readonly InkElementV1[],
  geometryVersion: number,
  scheduler: StoreSliceScheduler,
): Promise<PreparedReplacementRecords | "cancelled"> {
  const historyBuilder = source.history.createBuilder();
  const prepared: Omit<PreparedReplacementRecords, "history"> = {
    capacityPreviousRecords: [],
    capacityRecords: [],
    changes: [],
    records: [],
    spatialReplacements: [],
    yields: 0,
  };
  const work = new ReplacementCheckpoint(scheduler);
  for (const replacement of replacements) {
    if (cancelled(scheduler)) return "cancelled";
    const current = requireElementRecord(source.records, replacement.id);
    const proof = getCanonicalStrokeReplacementProof(replacement)!;
    if (proof.translation.x === 0 && proof.translation.y === 0) continue;
    const record = createOwnedTranslatedReplacementRecord(
      replacement,
      current,
      geometryVersion,
      current.paintVersion,
      proof.translation,
    );
    source.capacity.validateReplacementBounds(record);
    prepared.records.push(record);
    historyBuilder.append(current, record);
    prepared.spatialReplacements.push({ bounds: record.bounds, id: record.element.id });
    prepared.changes.push(
      Object.freeze({
        after: record,
        before: current,
        domains: CANONICAL_TRANSLATION_DOMAINS,
        id: record.element.id,
      }),
    );
    const checkpoint = work.checkpoint();
    if (checkpoint === false || (checkpoint !== true && !(await checkpoint))) return "cancelled";
  }
  return { ...prepared, history: historyBuilder.finish(), yields: work.yields };
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
    history: prepared.history,
    indexPatch,
    indexVisitCount: prepared.records.length,
    paintVersion: source.paintVersion,
    records: Object.freeze(prepared.records),
    replacementCount: prepared.records.length,
    reversePatches: Object.freeze([]),
    yields,
  };
}

function nextVersion(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("geometryVersion reached Number.MAX_SAFE_INTEGER.");
  }
  return value + 1;
}
