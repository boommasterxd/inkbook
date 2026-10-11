import type { InkElementV1 } from "../../../src/domain/schema/public";
import type { ElementStore } from "../../../src/domain/store/public";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";

export function createSynchronousActiveEditorHistory(store: ElementStore): ActiveEditorHistory {
  return new ActiveEditorHistory({
    commitBandOrder: () => undefined,
    commitElements: () => undefined,
    commitPage: () => undefined,
    removeElements: () => undefined,
    replaceElements: (elements: readonly InkElementV1[], capture) =>
      store.replaceMany(elements, capture),
  });
}
