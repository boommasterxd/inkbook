import type { ElementStore } from "../../../src/domain/store/public";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-session/vault-document-session";
import type { TransformSliceScheduler } from "../../../src/editor/selection/transform/transforms";

export function elementReplacementPorts(
  store: ElementStore,
  committed: () => void = () => undefined,
  work: TransformSliceScheduler = {
    shouldYield: () => false,
    yieldControl: () => Promise.resolve(),
  },
): Pick<
  EditableDocumentModel,
  "replaceElements" | "prepareElementReplacement" | "commitPreparedElementReplacement"
> {
  return {
    replaceElements: (elements, capture) => {
      if (store.replaceMany(elements, capture) !== null) committed();
    },
    prepareElementReplacement: (elements, cancellation) =>
      store.prepareElementReplacement(elements, {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => work.shouldYield(),
        yieldControl: () => work.yieldControl(),
      }),
    commitPreparedElementReplacement: (token, capture) => {
      const result = store.commitPreparedElementReplacement(token);
      if (result.status === "committed") committed();
      if (result.history !== null) capture?.(result.history);
      return result.status;
    },
  };
}

export function elementMutationPorts(
  store: ElementStore,
  committed: () => void,
  work: TransformSliceScheduler = {
    shouldYield: () => false,
    yieldControl: () => Promise.resolve(),
  },
): Pick<
  EditableDocumentModel,
  | "commitPreparedElementMutation"
  | "prepareElementMutation"
  | "prepareElementRemoval"
  | "prepareElementArrangement"
  | "prepareElementAppend"
> {
  return {
    prepareElementArrangement: (action, selection, cancellation) =>
      store.prepareElementArrangement(action, selection, {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => work.shouldYield(),
        yieldControl: () => work.yieldControl(),
      }),
    prepareElementAppend: (elements, cancellation) =>
      store.prepareElementAppend(elements, {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => work.shouldYield(),
        yieldControl: () => work.yieldControl(),
      }),
    commitPreparedElementMutation: (token) => {
      const result = store.commitPreparedElementMutation(token);
      if (result.status === "committed") committed();
      return result.transition;
    },
    prepareElementMutation: (mutation, cancellation) => {
      const scheduler = {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => work.shouldYield(),
        yieldControl: () => work.yieldControl(),
      };
      return cancellation.replaySource === "retained" && cancellation.replay !== undefined
        ? store.prepareHistoryReplay(mutation, scheduler, cancellation.replay)
        : store.prepareElementMutation(mutation, scheduler, cancellation.replay);
    },
    prepareElementRemoval: (ids, cancellation) => {
      const scheduler = {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => work.shouldYield(),
        yieldControl: () => work.yieldControl(),
      };
      return store.prepareElementRemoval(ids, scheduler);
    },
  };
}
