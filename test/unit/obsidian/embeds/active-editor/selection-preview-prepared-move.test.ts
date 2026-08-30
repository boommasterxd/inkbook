import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/selection-preview";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { rectangle } from "../../../domain/store/fixtures";

describe("prepared selection move completion", () => {
  it("restores the selection overlay when an accepted move fails asynchronously", () => {
    let complete: ((committed: boolean) => void) | undefined;
    const element = rectangle();
    const store = new ElementStore([element]);
    const sceneStore = new ElementSceneStore(store);
    const setSelectionOverlayPath =
      vi.fn<(path: string | null, fill?: "accent" | "none") => void>();
    const finish = vi.fn<(committed: boolean) => void>();
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
      history: {} as ActiveEditorHistory,
      pageToScreen: (point) => point,
      preparedHistory,
      renderer,
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
        kind: "element-move",
        pointer: pointer(0, 0),
        tool: "select",
      },
      store,
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

function pointer(x: number, y: number) {
  return { pointerId: 10, pointerType: "mouse" as const, pressure: 0.5, x, y };
}
