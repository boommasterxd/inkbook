import type { InkElementV1 } from "../schema/public";

import {
  classifyReplacementDrafts,
  prepareReplacementCandidatesTimeSliced,
  prepareReplacementDrafts,
  type ReplacementPlannerPorts,
} from "./replacement-planner";
import type { StoreSliceScheduler } from "./types";

export interface ReplacementPlan {
  readonly elements: readonly InkElementV1[];
  readonly replacements: readonly InkElementV1[];
  readonly yields: number;
}

export function prepareReplacementPlan(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
): ReplacementPlan {
  const drafts = prepareReplacementDrafts(replacements, ports);
  return finalizeReplacementPlan(replacements, drafts, ports, 0);
}

export async function prepareReplacementPlanTimeSliced(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
  scheduler: StoreSliceScheduler,
): Promise<ReplacementPlan | "cancelled"> {
  const prepared = await prepareReplacementCandidatesTimeSliced(replacements, ports, scheduler);
  if (prepared === "cancelled") return prepared;
  return {
    elements: Object.freeze(prepared.candidates.map(({ element }) => element)),
    replacements: Object.freeze(explicitFromDrafts(replacements, prepared.drafts)),
    yields: prepared.yields,
  };
}

function finalizeReplacementPlan(
  requested: readonly InkElementV1[],
  drafts: Map<string, InkElementV1>,
  ports: ReplacementPlannerPorts,
  yields: number,
): ReplacementPlan {
  const candidates = classifyReplacementDrafts(drafts, ports.getRecord);
  return {
    elements: Object.freeze(candidates.map(({ element }) => element)),
    replacements: Object.freeze(explicitFromDrafts(requested, drafts)),
    yields,
  };
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
