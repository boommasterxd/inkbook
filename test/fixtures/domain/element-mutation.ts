import {
  ElementStore,
  type AppliedElementMutation,
  type ElementMutation,
  type StoreDelta,
} from "../../../src/domain/store/public";
import type { ElementMutationCommitResult } from "../../../src/domain/store/types";

export const uninterruptedMutationScheduler = {
  shouldYield: () => false,
  yieldControl: async () => undefined,
};

/** Exercise private retained-history replay and require an atomic commit. */
export async function applyRetainedHistoryMutation(
  store: ElementStore,
  transition: AppliedElementMutation,
  direction: "forward" | "reverse",
): Promise<ElementMutationCommitResult> {
  const { token } = await store.prepareHistoryReplay(
    transition[direction],
    uninterruptedMutationScheduler,
    transition,
  );
  if (token === null) throw new Error("Expected retained replay token.");
  const result = store.commitPreparedElementMutation(token);
  if (result.status !== "committed") throw new Error("Expected committed retained replay.");
  return result;
}

/** Exercise the real prepared mutation boundary and require a complete committed transition. */
export async function applyElementMutation(
  store: ElementStore,
  mutation: ElementMutation,
  replay?: AppliedElementMutation,
): Promise<
  ElementMutationCommitResult & { delta: StoreDelta; transition: AppliedElementMutation }
> {
  const prepared = await store.prepareElementMutation(
    mutation,
    uninterruptedMutationScheduler,
    replay,
  );
  if (prepared.token === null) throw new Error("Expected prepared mutation.");
  const result = store.commitPreparedElementMutation(prepared.token);
  if (result.transition === null || result.delta === null)
    throw new Error("Expected committed mutation.");
  return result as ElementMutationCommitResult & {
    delta: StoreDelta;
    transition: AppliedElementMutation;
  };
}
