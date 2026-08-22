import {
  calculateElementBounds,
  canonicalPageBoundsCorrection,
  translateElementGeometry,
  unionBounds,
  type Bounds,
} from "../geometry/public";
import type { InkElementV1 } from "../schema/public";

import {
  classifyReplacementDrafts,
  classifyReplacementDraftsTimeSliced,
  prepareReplacementDrafts,
  prepareReplacementDraftsTimeSliced,
  type ReplacementPlannerPorts,
} from "./replacement-planner";
import { cancelled, yieldWhenRequested } from "./replacement-scheduler";
import type { StoreSliceScheduler } from "./types";

const MAX_CANONICAL_CORRECTION_PASSES = 3;

export interface PageBoundedReplacementPlan {
  readonly elements: readonly InkElementV1[];
  readonly replacements: readonly InkElementV1[];
  readonly yields: number;
}

export function preparePageBoundedReplacementCandidates(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
): PageBoundedReplacementPlan | null {
  let explicit = replacements;
  for (let pass = 0; pass < MAX_CANONICAL_CORRECTION_PASSES; pass += 1) {
    const drafts = prepareReplacementDrafts(explicit, ports);
    const correction = canonicalPageBoundsCorrection(combinedBounds(drafts.values()));
    if (correction === null) return null;
    if (correction.x === 0 && correction.y === 0) {
      return finalizePageBoundedCandidates(replacements, drafts, ports, 0);
    }
    explicit = correctedExplicitReplacements(replacements, drafts, correction);
  }
  return null;
}

export async function preparePageBoundedReplacementCandidatesTimeSliced(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
  scheduler: StoreSliceScheduler,
): Promise<PageBoundedReplacementPlan | "cancelled" | null> {
  let explicit = replacements;
  let yields = 0;
  for (let pass = 0; pass < MAX_CANONICAL_CORRECTION_PASSES; pass += 1) {
    const prepared = await prepareReplacementDraftsTimeSliced(explicit, ports, scheduler);
    if (prepared === "cancelled") return prepared;
    yields += prepared.yields;
    const measured = await combinedBoundsTimeSliced(prepared.drafts.values(), scheduler);
    if (measured === "cancelled") return measured;
    yields += measured.yields;
    const correction = canonicalPageBoundsCorrection(measured.bounds);
    if (correction === null) return null;
    if (correction.x === 0 && correction.y === 0) {
      return finalizePageBoundedCandidatesTimeSliced(
        replacements,
        prepared.drafts,
        ports,
        scheduler,
        yields,
      );
    }
    const corrected = await correctedExplicitReplacementsTimeSliced(
      replacements,
      prepared.drafts,
      correction,
      scheduler,
    );
    if (corrected === "cancelled") return corrected;
    explicit = corrected.replacements;
    yields += corrected.yields;
  }
  return null;
}

function finalizePageBoundedCandidates(
  requested: readonly InkElementV1[],
  drafts: Map<string, InkElementV1>,
  ports: ReplacementPlannerPorts,
  yields: number,
): PageBoundedReplacementPlan {
  const candidates = classifyReplacementDrafts(drafts, ports.getRecord);
  return {
    elements: Object.freeze(candidates.map(({ element }) => element)),
    replacements: Object.freeze(explicitFromDrafts(requested, drafts)),
    yields,
  };
}

async function finalizePageBoundedCandidatesTimeSliced(
  requested: readonly InkElementV1[],
  drafts: Map<string, InkElementV1>,
  ports: ReplacementPlannerPorts,
  scheduler: StoreSliceScheduler,
  yields: number,
): Promise<PageBoundedReplacementPlan | "cancelled"> {
  const classified = await classifyReplacementDraftsTimeSliced(drafts, ports.getRecord, scheduler);
  if (classified === "cancelled") return classified;
  return {
    elements: Object.freeze(classified.candidates.map(({ element }) => element)),
    replacements: Object.freeze(explicitFromDrafts(requested, drafts)),
    yields: yields + classified.yields,
  };
}

function correctedExplicitReplacements(
  requested: readonly InkElementV1[],
  drafts: ReadonlyMap<string, InkElementV1>,
  correction: Readonly<{ x: number; y: number }>,
): InkElementV1[] {
  return explicitFromDrafts(requested, drafts).map((element) =>
    translateElementGeometry(element, correction),
  );
}

async function correctedExplicitReplacementsTimeSliced(
  requested: readonly InkElementV1[],
  drafts: ReadonlyMap<string, InkElementV1>,
  correction: Readonly<{ x: number; y: number }>,
  scheduler: StoreSliceScheduler,
): Promise<
  { readonly replacements: readonly InkElementV1[]; readonly yields: number } | "cancelled"
> {
  const corrected: InkElementV1[] = [];
  let yields = 0;
  for (const { id } of requested) {
    if (cancelled(scheduler)) return "cancelled";
    corrected.push(translateElementGeometry(requireDraft(drafts, id), correction));
    const checkpoint = await yieldWhenRequested(scheduler);
    if (checkpoint === "cancelled") return checkpoint;
    yields += checkpoint;
  }
  return { replacements: corrected, yields };
}

function explicitFromDrafts(
  requested: readonly InkElementV1[],
  drafts: ReadonlyMap<string, InkElementV1>,
): InkElementV1[] {
  return requested.map(({ id }) => requireDraft(drafts, id));
}

function requireDraft(drafts: ReadonlyMap<string, InkElementV1>, id: string): InkElementV1 {
  const draft = drafts.get(id);
  if (draft === undefined) throw new Error(`Missing explicit replacement draft: ${id}`);
  return draft;
}

function combinedBounds(elements: Iterable<InkElementV1>): Bounds {
  let bounds: Bounds | undefined;
  for (const element of elements) {
    const next = calculateElementBounds(element);
    bounds = bounds === undefined ? next : unionBounds(bounds, next);
  }
  if (bounds === undefined) throw new RangeError("Page-bound correction needs an element.");
  return bounds;
}

async function combinedBoundsTimeSliced(
  elements: Iterable<InkElementV1>,
  scheduler: StoreSliceScheduler,
): Promise<{ readonly bounds: Bounds; readonly yields: number } | "cancelled"> {
  let bounds: Bounds | undefined;
  let yields = 0;
  for (const element of elements) {
    if (cancelled(scheduler)) return "cancelled";
    const next = calculateElementBounds(element);
    bounds = bounds === undefined ? next : unionBounds(bounds, next);
    const checkpoint = await yieldWhenRequested(scheduler);
    if (checkpoint === "cancelled") return checkpoint;
    yields += checkpoint;
  }
  if (bounds === undefined) throw new RangeError("Page-bound correction needs an element.");
  return { bounds, yields };
}
