import { vi } from "vitest";
import { reduceInput, type InputAction, type PointerSample } from "../../../src/editor/input";
import type { InputEffect } from "../../../src/editor/input/input-types";
import { ActiveEditorPointerController } from "../../../src/obsidian/embeds/active-editor/controller-pointer";
import { CoalescedPointerInput } from "../../../src/obsidian/embeds/active-editor/coalesced-input";
import type { ActiveEditorHandleInteraction } from "../../../src/obsidian/embeds/active-editor/handle-interaction";
import type { ActiveEditorMenuController } from "../../../src/obsidian/embeds/active-editor/controller-menu";
import type { ActiveEditorNavigation } from "../../../src/obsidian/embeds/active-editor/navigation";
import type { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { SvgSceneRenderer } from "../../../src/rendering/scene";
import { toolCursorHarness } from "./tool-cursor";

export function activeEditorPointerHarness() {
  const h = toolCursorHarness();
  const effects: InputEffect[] = [];
  const capture = vi.fn();
  const release = vi.fn();
  const beginGestureGeometry = vi.fn(() => true);
  const cancelPanMomentum = vi.fn();
  const recordTouchPan = vi.fn();
  const releaseTouchPan = vi.fn();
  const hit = vi.fn(() => null);
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
    dispatchMove: (sample) => dispatch({ type: "pointer-move", ...sample }),
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
    selection: () => new Set(),
    setLastPointer: h.controller.recordSessionPointer,
    ownerWindow: h.window as unknown as Window,
    renderer: {
      inputSurface: { focus: vi.fn() },
      interruptMotionForPointerDown: vi.fn(),
    } as unknown as SvgSceneRenderer,
    handles: {
      pointerDown: () => false,
      pointerMove: () => false,
      pointerUp: () => false,
      cancel: () => false,
    } as unknown as ActiveEditorHandleInteraction,
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
    sceneStore: { hit } as unknown as ElementSceneStore,
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
  };
}
