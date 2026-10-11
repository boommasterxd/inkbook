import type { EndpointReference, StoreSliceScheduler } from "./types";

/** Adding source -> target is acyclic exactly when target cannot reach source. */
export async function prepareConnectionCycleTargets(
  sourceId: string,
  beginDependents: (id: string) => IterableIterator<EndpointReference>,
  scheduler: StoreSliceScheduler,
): Promise<Set<string> | null> {
  const forbidden = new Set([sourceId]);
  const pending = [sourceId];
  let cursor: IterableIterator<EndpointReference> | undefined;
  try {
    while (pending.length > 0) {
      cursor = beginDependents(pending.pop()!);
      for (;;) {
        if (scheduler.isCancelled?.()) return null;
        if (scheduler.shouldYield()) await scheduler.yieldControl();
        if (scheduler.isCancelled?.()) return null;
        const step = cursor.next();
        if (step.done) break;
        if (!forbidden.has(step.value.linearId)) {
          forbidden.add(step.value.linearId);
          pending.push(step.value.linearId);
        }
      }
      cursor = undefined;
    }
    return forbidden;
  } finally {
    cursor?.return?.();
  }
}
