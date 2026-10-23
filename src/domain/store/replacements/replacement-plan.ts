import type { InkElementV1 } from "../../schema/public";

import {
  prepareReplacementCandidatesTimeSliced,
  prepareReplacementCandidates,
  type ReplacementCandidate,
  type ReplacementPlannerPorts,
} from "./replacement-planner";
import { immutableReplacementSteps } from "../records/immutability";
import {
  getCanonicalStrokeReplacementProof,
  isValidatedInternalStyleReplacement,
} from "../../elements/stroke-replacement-proof";
import type { StoreSliceScheduler } from "../types";

export interface ReplacementPlan {
  readonly elements: readonly InkElementV1[];
  readonly replacements: readonly InkElementV1[];
  readonly yields: number;
}

export function prepareReplacementPlan(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
): ReplacementPlan & { readonly candidates: readonly ReplacementCandidate[] } {
  const candidates = prepareReplacementCandidates(replacements, ports).map((candidate) => {
    if (
      candidate.retainedRecord?.element === candidate.element ||
      isValidatedInternalStyleReplacement(candidate.current.element, candidate.element) ||
      getCanonicalStrokeReplacementProof(candidate.element)?.source === candidate.current.element
    ) {
      return { ...candidate, owned: true };
    }
    const steps = immutableReplacementSteps(candidate.element, candidate.current.element);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return { ...candidate, element: step.value as InkElementV1, owned: true };
  });
  const elements = Object.freeze(candidates.map(({ element }) => element));
  const byId = new Map(elements.map((element) => [element.id, element]));
  return {
    candidates,
    elements,
    replacements: Object.freeze(
      replacements.map(
        (element) => byId.get(element.id) ?? (ports.getRecord(element.id).element as InkElementV1),
      ),
    ),
    yields: 0,
  };
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
