import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import { SelectionFrameSession } from "../../../../../src/editor/selection/public";
import { selectionTargetAt } from "../../../../../src/obsidian/embeds/active-editor/controller-elements";
import { ActiveEditorHandleInteraction } from "../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/previews/move-preview";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { createSelectionPreviewRenderer } from "../../../../fixtures/obsidian/selection-preview-renderer";
import { createInputState } from "../../../../../src/editor/input";
import { activeEditorPointerHarness } from "../../../../fixtures/obsidian/active-editor-pointer";
import { timedCursorPointerEvent as sample } from "../../../../fixtures/obsidian/tool-cursor";

it("shares 10,000 selected records across handles, target lookup and move startup", () => {
  const elements = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const renderer = {
    ...createSelectionPreviewRenderer(),
    setSelectionOverlayPath: vi.fn(),
    clearElementPreviews: vi.fn(),
    setElementPreviews: vi.fn(),
    setSnapMarkerPath: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
  };
  const state = { selection: new Set(elements.map(({ id }) => id)), revision: 0, zoom: 1 };
  const frames = new SelectionFrameSession();
  const handles = new ActiveEditorHandleInteraction({
    frameScheduler: new ManualFrameScheduler(),
    history: {} as never,
    preparedHistory: {} as never,
    model: {
      store,
      get revision() {
        return state.revision;
      },
    } as never,
    pageToScreen: (point) => point,
    renderer,
    sceneStore,
    selection: () => state.selection,
    selectionFrames: frames,
    zoom: () => state.zoom,
  });
  const read = vi.spyOn(store, "get");
  const pointer = { x: 500, y: 500, pointerId: 1, pointerType: "mouse" as const };
  const geometry = () => handles.selectionGeometry();
  try {
    for (const zoom of [1, 2, 0.5]) {
      state.zoom = zoom;
      expect(handles.pointerDown(pointer)).toBe(false);
      expect(
        selectionTargetAt(sceneStore, state.selection, pointer, "mouse", zoom, {
          frames,
          geometry,
        }),
      ).toEqual({ elementId: elements[0]!.id, isSelected: true });
      const preview = new MovePreview({
        history: {} as never,
        pageToScreen: (point) => point,
        preparedHistory: {} as never,
        renderer,
        sceneStore,
        selection: () => state.selection,
        selectionGeometry: geometry,
        selectionFrames: frames,
        setSelection: vi.fn(),
        start: { additive: false, kind: "element-move", pointer, tool: "select" },
        store,
      });
      preview.revert();
      handles.renderCameraSelection();
      expect(read).toHaveBeenCalledTimes(elements.length);
    }
    const original = geometry();
    state.revision += 1;
    expect(geometry()).not.toBe(original);
    expect(read).toHaveBeenCalledTimes(elements.length * 2);
    read.mockClear();
    store.remove([elements[0]!.id]);
    read.mockClear();
    expect(geometry()).toHaveLength(elements.length - 1);
    expect(read).toHaveBeenCalledTimes(elements.length);
    read.mockClear();
    state.selection = new Set([elements[1]!.id]);
    expect(geometry()).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    state.selection.clear();
    expect(geometry()).toEqual([]);
    handles.dispose();
    expect(geometry()).toEqual([]);
    expect(store.instrumentation.snapshotMaterializations).toBe(0);
  } finally {
    read.mockRestore();
    handles.dispose();
    sceneStore.release();
  }
});

it.each(["mouse", "pen"] as const)(
  "performs zero document queries or candidate reads when %s area dragging over 10,000 coincident strokes",
  (pointerType) => {
    const elements = Array.from({ length: 10_000 }, (_, index) => ({
      ...indexedStroke(index),
      pivot: { x: 20, y: 20 },
      points: [20, 20, 0.5],
    }));
    const h = activeEditorPointerHarness(elements);
    const query = vi.spyOn(h.store, "query");
    const read = vi.spyOn(h.store, "get");
    const pressure = vi.spyOn(h.store, "pressureGeometry");
    const movement = vi.spyOn(Math, "hypot");
    h.controls.input = createInputState({ activeTool: "select" });
    const contact = { pointerType, pressure: 0.5, buttons: 1, button: 0, clientX: 40, clientY: 50 };
    try {
      h.store.resetInstrumentation();
      h.pointer.handlePointerDown(sample(10, contact));
      expect(h.pointer.longPressTarget(2)).toBeUndefined();
      const batch = Array.from({ length: 4096 }, (_, index) =>
        sample(20 + index, { ...contact, clientX: index === 0 ? 47 : 40 }),
      );
      h.pointer.handlePointerMove(sample(4115, { ...contact, getCoalescedEvents: () => batch }));
      expect(h.pointer.longPressTarget(1)).toBeUndefined();
      h.pointer.handlePointerCancel(sample(4120, contact));
      expect(h.pointer.longPressTarget(1)).toBeUndefined();
      expect(
        h.effects.some((effect) => effect.type === "begin-preview" && effect.kind === "lasso"),
      ).toBe(true);
      expect(h.controls.input.interaction).toBeUndefined();
      expect(h.hit).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(pressure).not.toHaveBeenCalled();
      expect(movement.mock.calls.length).toBeGreaterThanOrEqual(batch.length);
      expect(movement.mock.calls.length).toBeLessThanOrEqual(batch.length + 2);
      expect(h.store.instrumentation.fullStoreScans).toBe(0);
      expect(h.store.instrumentation.snapshotMaterializations).toBe(0);
    } finally {
      query.mockRestore();
      read.mockRestore();
      pressure.mockRestore();
      movement.mockRestore();
      h.controller.dispose();
    }
  },
);
