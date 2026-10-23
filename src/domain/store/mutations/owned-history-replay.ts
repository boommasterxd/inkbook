import type { InkElementV1 } from "../../schema/public";
import {
  ownedReplayRecords,
  type OwnedMutationHistory,
  type OwnedMutationReplay,
} from "./owned-mutation-history";
import type { AppliedElementMutation, ElementMutation, ElementRecord } from "../types";

export function resolveHistoryReplay(
  requested: ElementMutation,
  replay?: AppliedElementMutation,
  proof?: OwnedMutationReplay,
) {
  if (replay !== undefined && requested !== replay.forward && requested !== replay.reverse) {
    throw new RangeError("History replay must use a retained transition direction.");
  }
  return {
    requested: proof?.retainedMutation ?? requested,
    records: ownedReplayRecords(requested, replay, proof?.history),
  };
}

/** Resolve only store-retained values; public transition element copies are never consumed. */
export function* ownedHistoryReplaySteps(
  requested: ElementMutation,
  replay: AppliedElementMutation,
  history: OwnedMutationHistory,
  current: ReadonlyMap<string, ElementRecord>,
): Generator<void, ElementMutation> {
  if (requested !== replay.forward && requested !== replay.reverse) {
    throw new RangeError("History replay must use a retained transition direction.");
  }
  const forward = requested === replay.forward;
  const previous = forward ? history.reverse : history.forward;
  const next = forward ? history.forward : history.reverse;
  const elements: InkElementV1[] = [];
  const removeIds: string[] = [];
  for (const [id, record] of previous) {
    if (current.get(id)?.element !== record.element) {
      throw new RangeError("Retained history source no longer matches the store.");
    }
    if (!next.has(id)) removeIds.push(id);
    yield;
  }
  for (const [id, record] of next) {
    if (!previous.has(id) && current.has(id)) {
      throw new RangeError("Retained history insertion already exists in the store.");
    }
    elements.push(record.element as InkElementV1);
    yield;
  }
  return { bands: requested.bands, elements, removeIds };
}
