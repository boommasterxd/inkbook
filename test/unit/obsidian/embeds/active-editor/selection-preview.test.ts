import { describe, expect, it, vi } from "vitest";

import {
  MovePreview,
  type SelectionEdgeDragPort,
} from "../../../../../src/obsidian/embeds/active-editor/selection-preview";
import type { ElementStore } from "../../../../../src/domain/store/public";
import type { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";

function createPreview(edgeDrag: SelectionEdgeDragPort) {
  const store = { get: () => undefined } as unknown as ElementStore;
  return new MovePreview({
    history: {} as ActiveEditorHistory,
    pageToScreen: ({ x, y }) => ({ x: x + 10, y: y + 20 }),
    preparedHistory: {} as PreparedElementHistory,
    renderer: {
      clearPreviewTransforms: vi.fn(),
      setOverlayPath: vi.fn(),
      setPreviewTransform: vi.fn(),
      suppressMotionForNextDelta: vi.fn(),
    },
    sceneStore: {
      query: (_bounds: unknown, _sink: unknown) => undefined,
    } as unknown as ElementSceneStore,
    selection: () => new Set(),
    selectionEdgeDrag: edgeDrag,
    setSelection: vi.fn(),
    start: {
      additive: false,
      kind: "element-move",
      pointer: { pointerId: 1, pointerType: "mouse", x: 5, y: 6 },
      tool: "select",
    },
    store,
  });
}

function createEdgeDrag() {
  return {
    begin: vi.fn<() => void>(),
    finish: vi.fn<(outcome: "cancel" | "commit") => void>(),
    setBottomEdge: vi.fn<(active: boolean) => void>(),
    update: vi.fn<(pointer: { readonly x: number; readonly y: number }) => void>(),
  };
}

describe("selection move edge-drag integration", () => {
  it("forwards screen-space movement and cancellation through the drag lifecycle", () => {
    const edgeDrag = createEdgeDrag();
    const preview = createPreview(edgeDrag);
    expect(edgeDrag.begin).toHaveBeenCalledOnce();

    preview.update({ pointerId: 1, pointerType: "mouse", x: 20, y: 30 });
    expect(edgeDrag.update).toHaveBeenCalledWith({ x: 30, y: 50 });
    preview.revert();
    expect(edgeDrag.finish).toHaveBeenCalledWith("cancel");
  });

  it("restores the exact committed height even when the move is a no-op", () => {
    const edgeDrag = createEdgeDrag();
    const preview = createPreview(edgeDrag);

    expect(preview.commit()).toBe(false);
    expect(edgeDrag.finish).toHaveBeenCalledWith("commit");
  });
});
