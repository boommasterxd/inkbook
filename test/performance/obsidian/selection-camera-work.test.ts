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
      get revision() {
        return state.revision;
      },
    } as EditableDocumentModel,
    pageToScreen: (point) => ({ x: point.x * state.zoom + 10, y: point.y * state.zoom }),
    renderer,
    sceneStore,
    selection: () => state.selection,
    zoom: () => state.zoom,
  });
  return { interaction, state, renderer, sceneStore };
}

it("reprojects 10,000 selected elements without rereading them until selection or revision changes", () => {
  const elements = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
  const test = fixture(elements);
  const read = vi.spyOn(test.sceneStore, "get");
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
