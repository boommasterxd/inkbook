import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { MovePreview } from "../../../../src/obsidian/embeds/active-editor/move-preview";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { ManualFrameScheduler } from "../../../fixtures/obsidian/manual-frame-scheduler";
import { rectangle } from "../../../unit/domain/store/fixtures";

describe("active editor selection-move frames", () => {
  it("coalesces S Pen bursts and flushes the latest pending sample before commit", () => {
    const fixture = setup(4);

    fixture.preview.updateSamples([pointer(4, 320, 250), pointer(4, 340, 270)]);
    fixture.preview.update(pointer(4, 360, 280));

    expect(fixture.scheduler.pendingCount).toBe(1);
    expect(fixture.transforms).toEqual([]);
    fixture.scheduler.runNext();
    expect(fixture.transforms).toEqual(["translate(60 40)"]);

    fixture.preview.update(pointer(4, 390, 300));
    expect(fixture.preview.commit()).toBe(true);
    expect(fixture.scheduler.cancelledFrames).toBe(1);
    expect(fixture.store.get(fixture.target.id)?.element).toMatchObject({ x: 190, y: 160 });
  });

  it("discards the pending move frame when the gesture is reverted", () => {
    const fixture = setup(5);

    fixture.preview.update(pointer(5, 360, 280));
    fixture.preview.revert();

    expect(fixture.scheduler.pendingCount).toBe(0);
    expect(fixture.scheduler.cancelledFrames).toBe(1);
    expect(fixture.transforms.filter((transform) => transform !== null)).toEqual([]);
    expect(fixture.store.get(fixture.target.id)?.element).toEqual(fixture.target);
  });
});

function setup(pointerId: number) {
  const target = rectangle();
  const store = new ElementStore([target]);
  const sceneStore = new ElementSceneStore(store);
  const scheduler = new ManualFrameScheduler();
  const transforms: Array<string | null> = [];
  const history = new ActiveEditorHistory({
    commitBandOrder: vi.fn(),
    commitElements: vi.fn(),
    commitPage: vi.fn(),
    removeElements: vi.fn(),
    replaceElements: (elements) => {
      store.replaceMany(elements);
    },
  });
  const renderer = {
    clearElementPreviews: vi.fn(),
    clearPreviewTransforms: () => transforms.push(null),
    flushPointerFeedbackFrame: vi.fn(),
    setElementPreviews: vi.fn(),
    setOverlayPath: vi.fn(),
    setPreviewTransform: (_ids: readonly string[], transform: string | null) =>
      transforms.push(transform),
    setSelectionOverlayPath: vi.fn(),
    setSnapMarkerPath: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
  };
  const preview = new MovePreview({
    frameScheduler: scheduler,
    history,
    pageToScreen: (point) => point,
    preparedHistory: { commitMove: () => false } as never,
    renderer,
    sceneStore,
    selection: () => new Set([target.id]),
    setSelection: vi.fn(),
    start: {
      additive: false,
      kind: "element-move",
      pointer: pointer(pointerId, 300, 240),
      tool: "select",
    },
    store,
  });
  return { preview, scheduler, store, target, transforms };
}

function pointer(pointerId: number, x: number, y: number) {
  return { pointerId, pointerType: "pen" as const, pressure: 0.5, x, y };
}
