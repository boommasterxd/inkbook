import { vi } from "vitest";

import type { ElementStore } from "../../../src/domain/store/public";
import type { CreationPreviewRenderer } from "../../../src/obsidian/embeds/active-editor/previews/creation-preview";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";

export function activeEditorStoreHistory(store: ElementStore): ActiveEditorHistory {
  return new ActiveEditorHistory({
    commitBandOrder: (order) => void store.reorderBands(order),
    commitElements: (elements) => void store.create(elements),
    commitPage: vi.fn(),
    removeElements: (ids) => void store.remove(ids),
    replaceElements: (elements, capture) => void store.replaceMany(elements, capture),
  });
}

export function creationPreviewRenderer(
  overrides: Partial<CreationPreviewRenderer> = {},
): CreationPreviewRenderer {
  return {
    clearLiveStroke: () => undefined,
    commitLiveStroke: () => undefined,
    commitLivePath: () => undefined,
    setLivePath: () => undefined,
    setSnapMarkerPath: () => undefined,
    suppressMotionForNextDelta: () => undefined,
    updateLiveStroke: () => undefined,
    ...overrides,
  };
}
