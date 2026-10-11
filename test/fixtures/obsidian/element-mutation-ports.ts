import type { ElementStore } from "../../../src/domain/store/public";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/vault-document-session";
import type { TransformSliceScheduler } from "../../../src/editor/selection/transforms";

export function elementMutationPorts(
  store: ElementStore,
  committed: () => void,
  work: TransformSliceScheduler = {
    shouldYield: () => false,
    yieldControl: () => Promise.resolve(),
  },
): Pick<
  EditableDocumentModel,
  "commitPreparedElementMutation" | "prepareElementMutation" | "prepareElementRemoval"
> {
  return {
    commitPreparedElementMutation: (token) => {
      const result = store.commitPreparedElementMutation(token);
      if (result.status === "committed") committed();
      return result.transition;
    },
    prepareElementMutation: (mutation, cancellation) =>
      store.prepareElementMutation(
        mutation,
        {
          isCancelled: () => cancellation.isCancelled(),
          shouldYield: () => work.shouldYield(),
          yieldControl: () => work.yieldControl(),
        },
        cancellation.replay,
      ),
    prepareElementRemoval: async (ids, cancellation) => {
      const scheduler = {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => work.shouldYield(),
        yieldControl: () => work.yieldControl(),
      };
      const mutation = await store.createRemovalMutationTimeSliced(ids, scheduler);
      if (mutation === "cancelled") return { status: "cancelled", token: null };
      if (mutation === null) return { status: "noop", token: null };
      return store.prepareElementMutation(mutation, scheduler);
    },
  };
}
