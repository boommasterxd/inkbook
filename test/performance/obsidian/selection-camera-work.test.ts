import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { PreparedElementHistory } from "../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { moveSelection } from "../../../src/editor/selection/transforms";
import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { ActiveEditorHandleInteraction } from "../../../src/obsidian/embeds/active-editor/handle-interaction";
import type { HandleInteractionRenderer } from "../../../src/obsidian/embeds/active-editor/handle-presentation";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-model-port";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { ManualFrameScheduler } from "../../fixtures/obsidian/manual-frame-scheduler";
import { createSelectionPreviewRenderer } from "../../fixtures/obsidian/selection-preview-renderer";
import * as bounds from "../../../src/domain/geometry/bounds";
import { selectionOverlayGeometry } from "../../../src/editor/selection/public";
import { workSchedulerFromFrames } from "../../fixtures/obsidian/work-scheduler";

function fixture(elements: readonly InkElementV1[]) {
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const state = { selection: new Set(elements.map(({ id }) => id)), revision: 0, zoom: 1 };
  const renderer = {
    ...createSelectionPreviewRenderer(),
    clearElementPreviews: vi.fn(),
    setElementPreviews: vi.fn(),
    setSelectionOverlayPath: vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>(),
    setSnapMarkerPath: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
  };
  const interaction = new ActiveEditorHandleInteraction({
    frameScheduler: new ManualFrameScheduler(),
    history: {} as never,
    preparedHistory: {} as never,
    model: {
      store,
      setGestureActive: vi.fn(),
      get revision() {
        return state.revision;
      },
    } as unknown as EditableDocumentModel,
    pageToScreen: (point) => ({ x: point.x * state.zoom + 10, y: point.y * state.zoom }),
    renderer,
    sceneStore,
    selection: () => state.selection,
    zoom: () => state.zoom,
  });
  return { interaction, state, renderer, sceneStore };
}

function largeSelectionFixture() {
  const elements = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
  const test = fixture(elements);
  return { elements, test, read: vi.spyOn(test.sceneStore, "get") };
}

it("reprojects 10,000 selected elements without rereading them until selection or revision changes", () => {
  const { elements, test, read } = largeSelectionFixture();
  try {
    test.interaction.renderCameraSelection();
    expect(read).toHaveBeenCalledTimes(elements.length);
    read.mockClear();
    for (const zoom of [1, 2, 0.5]) {
      test.state.zoom = zoom;
      test.interaction.renderCameraSelection();
    }
    expect(read).not.toHaveBeenCalled();
    test.state.revision += 1;
    test.interaction.renderCameraSelection();
    expect(read).toHaveBeenCalledTimes(elements.length);
    read.mockClear();
    test.state.selection = new Set([elements[0]!.id]);
    test.interaction.renderCameraSelection();
    expect(read).toHaveBeenCalledTimes(1);
    test.state.selection = new Set();
    test.interaction.renderCameraSelection();
    expect(test.renderer.setSelectionOverlayPath).toHaveBeenLastCalledWith(null, "accent", null);
  } finally {
    read.mockRestore();
    test.interaction.dispose();
    test.sceneStore.release();
  }
});

it("restores a cancelled 10,000-stroke handle preview from retained selection geometry", () => {
  const { elements, test, read } = largeSelectionFixture();
  try {
    test.interaction.renderSelection();
    const geometry = selectionOverlayGeometry(
      elements.map((element) => ({ element, bounds: bounds.calculateElementBounds(element) })),
      1,
    );
    const handle = geometry?.handles.find(
      (candidate) => candidate.kind === "scale" && candidate.position === "bottom-right",
    );
    if (handle === undefined) throw new Error("Expected a resize handle.");
    const pointer = { ...handle.point, pointerId: 1, pointerType: "mouse" as const };
    expect(test.interaction.pointerDown(pointer)).toBe(true);
    read.mockClear();

    expect(test.interaction.cancel(pointer.pointerId)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(test.renderer.setSelectionOverlayPath).toHaveBeenCalled();
  } finally {
    read.mockRestore();
    test.interaction.dispose();
    test.sceneStore.release();
  }
});

it("reuses a rotated stroke outline for camera changes without recalculating sample bounds", () => {
  const stroke = {
    ...indexedStroke(0),
    rotation: 37,
    points: Array.from({ length: 250 }, (_, i) => [i, i % 7, 0.5]).flat(),
  };
  const test = fixture([stroke]);
  const calculate = vi.spyOn(bounds, "calculateElementBounds");
  try {
    test.interaction.renderSelection();
    const before = test.renderer.setSelectionOverlayPath.mock.lastCall;
    expect(calculate).toHaveBeenCalled();
    calculate.mockClear();
    test.state.zoom = 2;
    test.interaction.renderCameraSelection();
    expect(test.renderer.setSelectionOverlayPath.mock.lastCall).not.toEqual(before);
    test.state.zoom = 1;
    test.interaction.renderCameraSelection();
    const restored = test.renderer.setSelectionOverlayPath.mock.lastCall;
    expect(restored?.slice(0, 2)).toEqual(before?.slice(0, 2));
    const numbers = (value: string) => value.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const expectedHandles = numbers(before![2]!);
    const actualHandles = numbers(restored![2]!);
    expect(actualHandles).toHaveLength(expectedHandles.length);
    actualHandles.forEach((value, index) => expect(value).toBeCloseTo(expectedHandles[index]!, 9));
    expect(calculate).not.toHaveBeenCalled();
  } finally {
    calculate.mockRestore();
    test.interaction.dispose();
    test.sceneStore.release();
  }
});

it.each([false, true])(
  "retains 10,000 stroke shapes through real history replay: async=%s",
  async (asynchronous) => {
    const builder = ElementStore.createBuilder({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    await builder.appendOwnedRuntime(
      Array.from({ length: 10_000 }, (_, index) => {
        const source = indexedStroke(index);
        return { ...source, points: new Float64Array(source.points) } as unknown as InkElementV1;
      }),
    );
    const store = await builder.finalize();
    if (store === null) throw new Error("Expected runtime store");
    const originals = store
      .materializeBandOrder("content")
      .map((id) => store.get(id)!.element) as unknown as InkElementV1[];
    const model = {
      ...({} as EditableDocumentModel),
      store,
      replaceElements: (elements: readonly InkElementV1[]) => {
        store.replaceMany(elements);
      },
      prepareElementReplacement: (elements: readonly InkElementV1[]) =>
        store.prepareElementReplacement(elements, {
          shouldYield: () => false,
          yieldControl: async () => undefined,
        }),
      commitPreparedElementReplacement: (
        token: Parameters<typeof store.commitPreparedElementReplacement>[0],
      ) => store.commitPreparedElementReplacement(token).status,
    } as EditableDocumentModel;
    const history = new ActiveEditorHistory(model);
    const prepared = new PreparedElementHistory({
      history,
      model,
      isAttached: () => true,
      onPendingChanged: () => undefined,
      motion: { beginPreviewCommit: () => ({ arm: () => true, cancel: () => undefined }) },
      workScheduler: workSchedulerFromFrames({
        cancelAnimationFrame: () => undefined,
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          queueMicrotask(() => callback(0));
          return 1;
        },
      }),
    });
    const geometry = vi.spyOn(bounds, "calculateElementBounds");
    try {
      if (asynchronous) {
        const completed = new Promise<boolean>((resolve) => {
          expect(prepared.commitMove(originals, { x: 2, y: 3 }, resolve)).toBe(true);
        });
        expect(await completed).toBe(true);
      } else {
        expect(history.replace(originals, moveSelection(originals, { x: 2, y: 3 }))).toBe(true);
      }
      expect(await history.undoAsync()).toBe(true);
      for (const original of originals) {
        const restored = store.get(original.id)!.element;
        if (restored.kind !== "stroke" || original.kind !== "stroke")
          throw new Error("Expected stroke");
        expect(restored.points).toBe(original.points);
        expect(restored.offset?.x ?? 0).toBe(0);
      }
      expect(await history.redoAsync()).toBe(true);
      for (const original of originals) {
        const moved = store.get(original.id)!.element;
        if (moved.kind !== "stroke" || original.kind !== "stroke")
          throw new Error("Expected stroke");
        expect(moved.points).toBe(original.points);
        expect(moved.offset).toEqual({ x: 2, y: 3 });
      }
      expect(geometry).not.toHaveBeenCalled();
    } finally {
      geometry.mockRestore();
      prepared.dispose();
      history.dispose();
    }
  },
);
