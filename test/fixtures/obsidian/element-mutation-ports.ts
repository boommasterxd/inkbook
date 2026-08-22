import type { ElementStore } from "../../../src/domain/store/public";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/vault-document-session";

export function elementMutationPorts(
  store: ElementStore,
  committed: () => void,
): Pick<EditableDocumentModel, "commitPreparedElementMutation" | "prepareElementMutation"> {
  return {
    commitPreparedElementMutation: (token) => {
      const result = store.commitPreparedElementMutation(token);
      if (result.status === "committed") committed();
      return result.transition;
    },
    prepareElementMutation: (mutation, cancellation) =>
      store.prepareElementMutation(mutation, {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => false,
        yieldControl: () => Promise.resolve(),
      }),
  };
}
