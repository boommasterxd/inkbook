import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { LassoPreview } from "../../../../../src/obsidian/embeds/active-editor/selection-preview";

describe("lasso preview regressions", () => {
  it.each([
    { additive: false, changed: true, expected: new Set<string>() },
    { additive: true, changed: false, expected: new Set(["selected-before-gesture"]) },
  ])("handles a degenerate lasso with additive=$additive", ({ additive, changed, expected }) => {
    const store = new ElementStore();
    const sceneStore = new ElementSceneStore(store);
    let selection: ReadonlySet<string> = new Set(["selected-before-gesture"]);
    const renderer = {
      clearPreviewTransforms: vi.fn(),
      setOverlayPath: vi.fn(),
      setPreviewTransform: vi.fn(),
      suppressMotionForNextDelta: vi.fn(),
    };
    const preview = new LassoPreview({
      history: {} as ActiveEditorHistory,
      pageToScreen: (point) => point,
      preparedHistory: {} as PreparedElementHistory,
      renderer,
      sceneStore,
      selection: () => selection,
      selectionDefaults: { area: "lasso", inclusion: "touched" },
      setSelection: (next) => {
        selection = next;
      },
      start: {
        additive,
        kind: "lasso",
        pointer: pointer(0, 0),
        tool: "select",
      },
      store,
    });
    preview.update(pointer(20, 0));

    expect(preview.commit()).toBe(changed);
    expect(selection).toEqual(expected);
    sceneStore.release();
  });
});

function pointer(x: number, y: number) {
  return { pointerId: 10, pointerType: "mouse" as const, pressure: 0.5, x, y };
}
