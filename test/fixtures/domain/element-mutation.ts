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
