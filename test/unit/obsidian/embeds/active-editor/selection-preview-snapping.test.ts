import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/selection-preview";
import { createSynchronousActiveEditorHistory } from "../../../../fixtures/obsidian/synchronous-active-editor-history";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { uuid } from "../../../domain/schema/fixtures";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";

const pointer = (x: number, y: number) => ({
  pointerId: 10,
  pointerType: "mouse" as const,
  x,
  y,
});

async function moveSnapHarness(
  connectionSnapping: boolean | (() => boolean) = true,
  selectionSize = 1,
) {
  const target = rectangle();
  const line = {
    ...connectedLine(target),
    end: { x: 350, y: 50 },
    pivot: { x: 200, y: 50 },
    start: { x: 50, y: 50 },
    startConnection: null,
  };
  const lines = Array.from({ length: selectionSize }, (_, index) => ({
    ...line,
    id: index === 0 ? line.id : uuid(50 + index),
    start: { x: 50, y: 50 + index * 50 },
    end: { x: 350, y: 50 + index * 50 },
    pivot: { x: 200, y: 50 + index * 50 },
  }));
  const store = new ElementStore([target, ...lines]);
  const sceneStore = new ElementSceneStore(store);
  const setPreviewTransform = vi.fn();
  const setSnapMarkerPath = vi.fn();
  const scheduler = immediateWorkScheduler();
  if (selectionSize === 1) await sceneStore.prepareConnections(line.id, scheduler);
  const preview = new MovePreview({
    workScheduler: scheduler,
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
    selection: () => new Set(lines.map(({ id }) => id)),
    setSelection: vi.fn(),
    start: {
      additive: false,
      kind: "element-move",
      pointer: pointer(0, 0),
      tool: "select",
    },
    store,
  });
  return {
    line,
    lines,
    preview,
    sceneStore,
    setPreviewTransform,
    setSnapMarkerPath,
    store,
    target,
  };
}

describe("selection move snapping settings", () => {
  it("snaps a moved free line endpoint to a shape and renders an offset target marker", async () => {
    const { line, preview, sceneStore, setPreviewTransform, setSnapMarkerPath, store, target } =
      await moveSnapHarness();

    preview.update(pointer(47, 48));

    expect(setPreviewTransform).toHaveBeenLastCalledWith(
      [line.id],
      "translate(50 50)",
      1,
      "scale",
      expect.any(Function),
    );
    expect(setSnapMarkerPath).toHaveBeenLastCalledWith("M 88 100 L 112 100 M 100 88 L 100 112");
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

  it("keeps a moved line free when connection snapping is disabled", async () => {
    const { line, preview, sceneStore, setPreviewTransform, setSnapMarkerPath, store } =
      await moveSnapHarness(false);

    preview.update(pointer(47, 48));

    expect(setPreviewTransform).toHaveBeenLastCalledWith(
      [line.id],
      "translate(47 48)",
      1,
      "scale",
      expect.any(Function),
    );
    expect(setSnapMarkerPath).toHaveBeenLastCalledWith(null);
    expect(preview.commit()).toBe(true);
    expect(store.get(line.id)?.element).toMatchObject({
      start: { x: 97, y: 98 },
      startConnection: null,
    });
    sceneStore.release();
  });

  it("removes and restores move snapping when the temporary override changes", async () => {
    let snappingEnabled = true;
    const { line, preview, sceneStore, setPreviewTransform, setSnapMarkerPath } =
      await moveSnapHarness(() => snappingEnabled);

    preview.update(pointer(47, 48));
    expect(setPreviewTransform).toHaveBeenLastCalledWith(
      [line.id],
      "translate(50 50)",
      1,
      "scale",
      expect.any(Function),
    );

    snappingEnabled = false;
    preview.update(pointer(47, 48));
    expect(setPreviewTransform).toHaveBeenLastCalledWith(
      [line.id],
      "translate(47 48)",
      2,
      "scale",
      expect.any(Function),
    );
    expect(setSnapMarkerPath).toHaveBeenLastCalledWith(null);

    snappingEnabled = true;
    preview.update(pointer(47, 48));
    expect(setPreviewTransform).toHaveBeenLastCalledWith(
      [line.id],
      "translate(50 50)",
      3,
      "scale",
      expect.any(Function),
    );
    sceneStore.release();
  });
});

describe("group move snapping boundary", () => {
  it("preserves raw group translation beside external anchors through temporary snapping overrides", async () => {
    let snappingEnabled = true;
    const { lines, preview, sceneStore, setPreviewTransform, setSnapMarkerPath, store } =
      await moveSnapHarness(() => snappingEnabled, 2);
    const query = vi.spyOn(sceneStore, "query");
    const targets = vi.spyOn(sceneStore, "getSnapTarget");
    const canConnect = vi.spyOn(sceneStore, "canConnect");
    const ids = lines.map(({ id }) => id);
    for (const [index, enabled] of [true, false, true].entries()) {
      snappingEnabled = enabled;
      preview.update(pointer(47, 48));
      expect(setPreviewTransform).toHaveBeenLastCalledWith(
        ids,
        "translate(47 48)",
        index + 1,
        "scale",
        expect.any(Function),
      );
      expect(setSnapMarkerPath).toHaveBeenLastCalledWith(null);
    }
    expect(preview.commit()).toBe(true);
    for (const line of lines) {
      expect(store.get(line.id)?.element).toMatchObject({
        start: { x: line.start.x + 47, y: line.start.y + 48 },
        end: { x: line.end.x + 47, y: line.end.y + 48 },
        startConnection: null,
        endConnection: null,
      });
    }
    expect(query).not.toHaveBeenCalled();
    expect(targets).not.toHaveBeenCalled();
    expect(canConnect).not.toHaveBeenCalled();
    expect(setSnapMarkerPath.mock.calls.every(([path]) => path === null)).toBe(true);
    sceneStore.release();
  });
});
