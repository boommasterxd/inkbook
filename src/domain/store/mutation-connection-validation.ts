import { dependencyCycleSteps } from "../schema/dependency-cycle";
import { connectionReferences } from "./connections";
import { checkpoint } from "./mutation-scheduler";
import type { ElementRecord, StoreSliceScheduler } from "./types";

export async function validateMutationConnectionCycles(
  records: ReadonlyMap<string, ElementRecord>,
  scheduler: StoreSliceScheduler,
): Promise<"cancelled" | "valid"> {
  const steps = dependencyCycleSteps(records.keys(), (id) => {
    const record = records.get(id);
    return record === undefined
      ? []
      : connectionReferences(record.element).map(({ targetId }) => targetId);
  });
  for (;;) {
    if (!(await checkpoint(scheduler))) return "cancelled";
    const step = steps.next();
    if (!step.done) continue;
    if (step.value) throw new RangeError("Linear endpoint connections must not form a cycle.");
    return "valid";
  }
}
