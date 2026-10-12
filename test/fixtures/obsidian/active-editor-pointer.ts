import { onTestFinished, vi } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import { reduceInput, type InputAction, type PointerSample } from "../../../src/editor/input";
import type { InputEffect } from "../../../src/editor/input/input-types";
import { ActiveEditorPointerController } from "../../../src/obsidian/embeds/active-editor/controller-pointer";
import { CoalescedPointerInput } from "../../../src/obsidian/embeds/active-editor/coalesced-input";
import { ActiveEditorHandleInteraction } from "../../../src/obsidian/embeds/active-editor/handle-interaction";
import type { ActiveEditorMenuController } from "../../../src/obsidian/embeds/active-editor/controller-menu";
import type { ActiveEditorNavigation } from "../../../src/obsidian/embeds/active-editor/navigation";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { SvgSceneRenderer } from "../../../src/rendering/scene";
import { toolCursorHarness } from "./tool-cursor";
import { ManualFrameScheduler } from "./manual-frame-scheduler";
import { createSelectionPreviewRenderer } from "./selection-preview-renderer";

export function activeEditorPointerHarness(
  elements: ConstructorParameters<typeof ElementStore>[0] = [],
) {
  const h = toolCursorHarness();
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const selection = new Set<string>();
  const handles = pointerHandles(store, sceneStore, selection);
  onTestFinished(() => {
    handles.dispose();
    sceneStore.release();
    store.releasePreparedPressureGeometry();
  });
  const effects: InputEffect[] = [];
  const capture = vi.fn();
  const release = vi.fn();
  const beginGestureGeometry = vi.fn(() => true);
  const cancelPanMomentum = vi.fn();
  const recordTouchPan = vi.fn();
  const releaseTouchPan = vi.fn();
  const hit = vi.spyOn(sceneStore, "hit");
  const dispatch = vi.fn((action: InputAction) => {
    const result = reduceInput(h.controls.input, action);
    h.controls.input = result.state;
    effects.push(...result.effects);
    for (const effect of result.effects) {
      if (effect.type === "capture-pointer") capture(effect.pointerId);
      if (effect.type === "release-pointer") release(effect.pointerId);
    }
    h.controller.refresh();
  });
  const screenPointer = vi.fn((event: PointerEvent): PointerSample => ({
    x: event.clientX - h.bounds.left,
    y: event.clientY - h.bounds.top,
    pointerId: event.pointerId,
    pointerType: event.pointerType as PointerSample["pointerType"],
    pressure: event.pressure,
  }));
  const coalescedInput = new CoalescedPointerInput({
    now: () => 0,
    project: screenPointer,
    dispatchMove: (sample) => dispatch(coalescedInput.moveAction(sample, h.controls.input)),
  });
  const coalesced = vi.spyOn(coalescedInput, "dispatch");
  const pointer = new ActiveEditorPointerController({
    cursor: h.controller,
    coalesced: coalescedInput,
    getInput: () => h.controls.input,
    dispatch,
    capturePointer: capture,
    releasePointer: release,
    beginHandlePointer: vi.fn(),
    finishHandlePointer: vi.fn(),
    interruptForInput: vi.fn(),
    isEnabled: () => h.controls.enabled,
    selection: () => selection,
    setLastPointer: h.controller.recordSessionPointer,
    ownerWindow: h.window as unknown as Window,
    renderer: {
      inputSurface: { focus: vi.fn() },
      interruptMotionForPointerDown: vi.fn(),
    } as unknown as SvgSceneRenderer,
    handles,
    menus: {
      dispatchFromEvent: (_event: unknown, run: () => void) => run(),
    } as ActiveEditorMenuController,
    navigation: {
      cancelPanMomentum,
      beginGestureGeometry,
      finish: vi.fn(),
      zoom: 1,
      screenPointer,
      pageSample: (sample: PointerSample) => sample,
      recordTouchPan,
      releaseTouchPan,
    } as unknown as ActiveEditorNavigation,
    sceneStore,
  });
  return {
    ...h,
    pointer,
    effects,
    capture,
    release,
    beginGestureGeometry,
    cancelPanMomentum,
    recordTouchPan,
    releaseTouchPan,
    hit,
    screenPointer,
    coalesced,
    dispatch,
    store,
    sceneStore,
    selection,
  };
}

/** Real empty-selection handling keeps pointer composition aligned with the production port. */
function pointerHandles(
  store: ElementStore,
  sceneStore: ElementSceneStore,
  selection: ReadonlySet<string>,
): ActiveEditorHandleInteraction {
  return new ActiveEditorHandleInteraction({
    frameScheduler: new ManualFrameScheduler(),
    history: {} as never,
    preparedHistory: {} as never,
    model: { store, revision: 0 } as never,
    pageToScreen: (point) => point,
    renderer: {
      ...createSelectionPreviewRenderer(),
      clearElementPreviews: vi.fn(),
      flushPointerFeedbackFrame: vi.fn(),
      setElementPreviews: vi.fn(),
      setSelectionOverlayPath: vi.fn(),
      setSnapMarkerPath: vi.fn(),
    },
    sceneStore,
    selection: () => selection,
    zoom: () => 1,
  });
}
