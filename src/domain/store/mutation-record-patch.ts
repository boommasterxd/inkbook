import type { ElementMutationPlan } from "./element-mutation";
import type { ElementRank, ElementRecord } from "./types";

/** Commit records and return the rank map that becomes authoritative. */
export function applyMutationRecordPatches(
  records: Map<string, ElementRecord>,
  ranks: Map<string, ElementRank>,
  plan: ElementMutationPlan,
): Map<string, ElementRank> {
  for (const [id, record] of plan.records) {
    if (record === null) {
      records.delete(id);
      if (!plan.ranksComplete) ranks.delete(id);
    } else records.set(id, record);
  }
  if (plan.ranksComplete) return plan.ranks;
  for (const [id, rank] of plan.ranks) ranks.set(id, rank);
  return ranks;
}
