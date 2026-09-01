import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/selection-preview";
import { createSynchronousActiveEditorHistory } from "../../../../fixtures/obsidian/synchronous-active-editor-history";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";

const pointer = (x: number, y: number) => ({
  pointerId: 10,
  pointerType: "mouse" as const,
  x,
  y,
});

function moveSnapHarness(connectionSnapping: boolean | (() => boolean) = true) {
  const target = rectangle();
  const line = {
    ...connectedLine(target),
    end: { x: 350, y: 50 },
    pivot: { x: 200, y: 50 },
    start: { x: 50, y: 50 },
    startConnection: null,
  };
  const store = new ElementStore([target, line]);
  const sceneStore = new ElementSceneStore(store);
  const setPreviewTransform = vi.fn();
  const setSnapMarkerPath = vi.fn();
  const preview = new MovePreview({
    connectionSnapping,
    history: createSynchronousActiveEditorHistory(store),
    pageToScreen: (point) => point,
    preparedHistory: { commitMove: vi.fn(() => false) } as unknown as PreparedElementHistory,
    renderer: {
      clearPreviewTransforms: vi.fn(),
      setOverlayPath: vi.fn(),
      setPreviewTransform,
      setSnapMarkerPath,
      suppressMotionForNextDelta: vi.fn(),
    },
    sceneStore,
    selection: () => new Set([line.id]),
    setSelection: vi.fn(),
    start: {
      additive: false,
      kind: "element-move",
      pointer: pointer(0, 0),
      tool: "select",
    },
    store,
  });
  return { line, preview, sceneStore, setPreviewTransform, setSnapMarkerPath, store, target };
}

describe("selection move snapping settings", () => {
  it("snaps a moved free line endpoint to a shape and renders an offset target marker", () => {
    const { line, preview, sceneStore, setPreviewTransform, setSnapMarkerPath, store, target } =
      moveSnapHarness();

    preview.update(pointer(47, 48));

    expect(setPreviewTransform).toHaveBeenLastCalledWith([line.id], "translate(50 50)", 1);
    expect(setSnapMarkerPath).toHaveBeenLastCalledWith("M 76 100 L 124 100 M 100 76 L 100 124");
    expect(preview.commit()).toBe(true);
    expect(store.get(line.id)?.element).toMatchObject({
      start: { x: 100, y: 100 },
      startConnection: {
        anchor: { kind: "box", position: "top-left" },
        targetId: target.id,
      },
    });
    expect(setSnapMarkerPath).toHaveBeenLastCalledWith(null);
    sceneStore.release();
  });

  it("keeps a moved line free when connection snapping is disabled", () => {
    const { line, preview, sceneStore, setPreviewTransform, setSnapMarkerPath, store } =
      moveSnapHarness(false);

    preview.update(pointer(47, 48));

    expect(setPreviewTransform).toHaveBeenLastCalledWith([line.id], "translate(47 48)", 1);
    expect(setSnapMarkerPath).toHaveBeenLastCalledWith(null);
    expect(preview.commit()).toBe(true);
    expect(store.get(line.id)?.element).toMatchObject({
      start: { x: 97, y: 98 },
      startConnection: null,
    });
    sceneStore.release();
  });

  it("removes and restores move snapping when the temporary override changes", () => {
    let snappingEnabled = true;
    const { line, preview, sceneStore, setPreviewTransform, setSnapMarkerPath } = moveSnapHarness(
      () => snappingEnabled,
    );

    preview.update(pointer(47, 48));
    expect(setPreviewTransform).toHaveBeenLastCalledWith([line.id], "translate(50 50)", 1);

    snappingEnabled = false;
    preview.update(pointer(47, 48));
    expect(setPreviewTransform).toHaveBeenLastCalledWith([line.id], "translate(47 48)", 2);
    expect(setSnapMarkerPath).toHaveBeenLastCalledWith(null);

    snappingEnabled = true;
    preview.update(pointer(47, 48));
    expect(setPreviewTransform).toHaveBeenLastCalledWith([line.id], "translate(50 50)", 3);
    sceneStore.release();
  });
});
