import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/selection-preview";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { createSynchronousActiveEditorHistory } from "../../../../fixtures/obsidian/synchronous-active-editor-history";
import { rectangle } from "../../../domain/store/fixtures";

describe("prepared selection move completion", () => {
  it("restores the selection overlay when an accepted move fails asynchronously", () => {
    let complete: ((committed: boolean) => void) | undefined;
    const element = rectangle();
    const store = new ElementStore([element]);
    const sceneStore = new ElementSceneStore(store);
    const setSelectionOverlayPath =
      vi.fn<(path: string | null, fill?: "accent" | "none") => void>();
    const finish = vi.fn<(committed: boolean, previewMaximumBottom?: number) => void>();
    const preparedHistory = {
      commitMove: (
        _elements: unknown,
        _delta: unknown,
        onCompleted?: (committed: boolean) => void,
      ) => {
        complete = onCompleted;
        return true;
      },
    } as unknown as PreparedElementHistory;
    const renderer = {
      clearPreviewTransforms: vi.fn(),
      setOverlayPath: vi.fn(),
      setPreviewTransform: vi.fn(),
      setSelectionOverlayPath,
      suppressMotionForNextDelta: vi.fn(),
    };
    const preview = new MovePreview({
      ...movePreviewOptions(element, store, sceneStore, finish),
      history: {} as ActiveEditorHistory,
      preparedHistory,
      renderer,
    });
    preview.update(pointer(40, 50));
    expect(preview.commit()).toBe(true);
    const movedPath = setSelectionOverlayPath.mock.lastCall?.[0];

    complete?.(false);

    const restoredPath = setSelectionOverlayPath.mock.lastCall?.[0];
    expect(restoredPath).not.toBe(movedPath);
    expect(restoredPath).toContain("M 98 98 L 302 98");
    expect(finish).toHaveBeenCalledWith(false);
    sceneStore.release();
  });
});

describe("selection move extent completion", () => {
  it("finishes a downward overshoot with the final rendered content bottom", () => {
    const element = rectangle();
    const store = new ElementStore([element]);
    const sceneStore = new ElementSceneStore(store);
    const finish = vi.fn<(committed: boolean, previewMaximumBottom?: number) => void>();
    const preview = new MovePreview({
      ...movePreviewOptions(element, store, sceneStore, finish),
      history: createSynchronousActiveEditorHistory(store),
      preparedHistory: { commitMove: vi.fn(() => false) } as unknown as PreparedElementHistory,
      renderer: {
        clearPreviewTransforms: vi.fn(),
        setOverlayPath: vi.fn(),
        setPreviewTransform: vi.fn(),
        suppressMotionForNextDelta: vi.fn(),
      },
    });

    preview.update(pointer(0, 1_000));
    preview.update(pointer(0, 200));

    expect(preview.commit()).toBe(true);
    expect(finish).toHaveBeenLastCalledWith(true, calculateElementBounds(element).maxY + 200);
    sceneStore.release();
  });
});

function movePreviewOptions(
  element: ReturnType<typeof rectangle>,
  store: ElementStore,
  sceneStore: ElementSceneStore,
  finish: (committed: boolean, previewMaximumBottom?: number) => void,
) {
  return {
    pageToScreen: (point: { readonly x: number; readonly y: number }) => point,
    sceneStore,
    selection: () => new Set([element.id]),
    selectionEdgeDrag: {
      begin: vi.fn(),
      finish,
      stop: vi.fn(),
      update: vi.fn(),
      updatePreviewBottom: vi.fn(),
    },
    setSelection: vi.fn(),
    start: {
      additive: false,
      kind: "element-move" as const,
      pointer: pointer(0, 0),
      tool: "select" as const,
    },
    store,
  };
}

function pointer(x: number, y: number) {
  return { pointerId: 10, pointerType: "mouse" as const, pressure: 0.5, x, y };
}
