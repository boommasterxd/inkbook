import { expect, it, vi } from "vitest";

import { MAX_STROKE_POINTS, type StrokeElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import * as strokePosition from "../../../../../src/domain/geometry/stroke-position";
import { layoutSelectionHandles } from "../../../../../src/editor/selection/handles";
import { SelectionFrameSession } from "../../../../../src/editor/selection/public";
import { ActiveEditorHandleInteraction } from "../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { selectionHandleAction } from "../../../../../src/obsidian/embeds/active-editor/previews/selection-handle-action";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { createSelectionPreviewRenderer } from "../../../../fixtures/obsidian/selection-preview-renderer";
import { observePointReads } from "../../../../fixtures/rendering/point-reads";
import { maximumStroke } from "../../../editor/maximum-stroke-fixture";
import { STROKE_FRAME_CASES } from "../../../../fixtures/editor/stroke-frame";

it.each(STROKE_FRAME_CASES)(
  "starts warm maximum-stroke handles without sample reads at $rotation degrees, collapsed=$collapsed, extreme pivot=$extremePivot",
  (input) => {
    const test = fixture(input.rotation, input.collapsed, input.extremePivot);
    const sample = vi.spyOn(strokePosition, "strokeWorldPoint");
    try {
      const selected = test.interaction.selectionGeometry();
      const frame = test.frames.current(selected)!;
      expect(sample).toHaveBeenCalledTimes(input.rotation === 0 ? 0 : MAX_STROKE_POINTS);
      sample.mockClear();
      const handles = layoutSelectionHandles(selected, { frame, zoom: 1 });
      let reads = 0;
      const element = selected[0]!.element as StrokeElementV1;
      const observed = {
        ...element,
        points: observePointReads(element.points, () => {
          reads += 1;
        }),
      };
      const observedSelection = [{ ...selected[0]!, element: observed }];
      for (const handle of handles) {
        const actual = selectionHandleAction(handle, observedSelection, frame);
        expect(actual.kind).toBe(handle.kind);
        expect(reads).toBe(0);
        expect(
          test.interaction.pointerDown({
            ...handle.point,
            pointerId: 1,
            pointerType: "mouse",
          }),
        ).toBe(true);
        expect(sample).not.toHaveBeenCalled();
        expect(
          test.interaction.pointerMove({
            x: handle.point.x + 20,
            y: handle.point.y + 10,
            pointerId: 1,
            pointerType: "mouse",
          }),
        ).toBe(true);
        test.frameScheduler.runNext();
        expect(sample).not.toHaveBeenCalled();
        expect(test.interaction.cancel(1)).toBe(true);
        expect(test.interaction.activePointerId).toBeUndefined();
        expect(sample).not.toHaveBeenCalled();
        expect(test.frames.current(selected)).toBe(frame);
      }
      // The observed sample boundary must also detect the uncached reference path.
      selectionHandleAction(handles[0]!, observedSelection, null);
      expect(reads).toBeGreaterThanOrEqual(MAX_STROKE_POINTS * 2);
      expect(sample).toHaveBeenCalledTimes(MAX_STROKE_POINTS);
    } finally {
      sample.mockRestore();
      test.interaction.dispose();
      test.sceneStore.release();
    }
  },
);

function fixture(rotation: number, collapsed: "none" | "x" | "y" | "both", extremePivot: boolean) {
  const source = maximumStroke(0);
  const stroke = {
    ...source,
    offset: { x: 17.003, y: -11.007 },
    pivot: extremePivot ? { x: 99_900, y: -99_900 } : { x: 100, y: 100 },
    points: source.points.map((value, index) => {
      if (index % 3 === 0 && (collapsed === "x" || collapsed === "both")) return 20;
      if (index % 3 === 1 && (collapsed === "y" || collapsed === "both")) return 30;
      return value;
    }),
    rotation,
  };
  const store = new ElementStore([stroke]);
  const sceneStore = new ElementSceneStore(store);
  const frames = new SelectionFrameSession();
  const frameScheduler = new ManualFrameScheduler();
  const selection = new Set([stroke.id]);
  const interaction = new ActiveEditorHandleInteraction({
    frameScheduler,
    history: {} as never,
    preparedHistory: {} as never,
    model: { store, revision: 0, setGestureActive: vi.fn() } as never,
    pageToScreen: (point) => point,
    renderer: {
      ...createSelectionPreviewRenderer(),
      clearElementPreviews: vi.fn(),
      setElementPreviews: vi.fn(),
      setSelectionOverlayPath: vi.fn(),
      setSnapMarkerPath: vi.fn(),
      flushPointerFeedbackFrame: vi.fn(),
    },
    sceneStore,
    selection: () => selection,
    selectionFrames: frames,
    zoom: () => 1,
  });
  return { frameScheduler, frames, interaction, sceneStore };
}
