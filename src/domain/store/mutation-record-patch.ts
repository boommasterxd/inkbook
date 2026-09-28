import type { ElementMutationPlan } from "./element-mutation";
import type { ElementRank, ElementRecord } from "./types";

export function applyMutationRecordPatches(
  records: Map<string, ElementRecord>,
  ranks: Map<string, ElementRank>,
  plan: ElementMutationPlan,
): void {
  for (const [id, record] of plan.records) {
    if (record === null) {
      records.delete(id);
      ranks.delete(id);
    } else records.set(id, record);
  }
  for (const [id, rank] of plan.ranks) ranks.set(id, rank);
}
