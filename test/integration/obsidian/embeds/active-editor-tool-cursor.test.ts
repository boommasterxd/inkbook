import { describe, expect, it, vi } from "vitest";
import { reduceInput, type InputAction, type PointerSample } from "../../../../src/editor/input";
import { ActiveEditorPointerController } from "../../../../src/obsidian/embeds/active-editor/controller-pointer";
import type { CoalescedPointerInput } from "../../../../src/obsidian/embeds/active-editor/coalesced-input";
import type { ActiveEditorHandleInteraction } from "../../../../src/obsidian/embeds/active-editor/handle-interaction";
import type { ActiveEditorMenuController } from "../../../../src/obsidian/embeds/active-editor/controller-menu";
import type { ActiveEditorNavigation } from "../../../../src/obsidian/embeds/active-editor/navigation";
import type { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { cursorPointerEvent, toolCursorHarness } from "../../../fixtures/obsidian/tool-cursor";

function harness() {
  const h = toolCursorHarness();
  const screenPointer = vi.fn((event: PointerEvent): PointerSample => ({
    x: event.clientX - h.bounds.left,
    y: event.clientY - h.bounds.top,
    pointerId: event.pointerId,
    pointerType: "mouse",
    pressure: event.pressure,
  }));
  const coalesced = vi.fn(() => true);
  const dispatch = vi.fn((action: InputAction) => {
    h.controls.input = reduceInput(h.controls.input, action).state;
    h.controller.refresh();
  });
  const controller = new ActiveEditorPointerController({
    cursor: h.controller,
    coalesced: { dispatch: coalesced } as unknown as CoalescedPointerInput,
    getInput: () => h.controls.input,
    dispatch,
    capturePointer: vi.fn(),
    releasePointer: vi.fn(),
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
      cancelPanMomentum: vi.fn(),
      beginGestureGeometry: () => true,
      finish: vi.fn(),
      zoom: 1,
      screenPointer,
      pageSample: (pointer: PointerSample) => pointer,
    } as unknown as ActiveEditorNavigation,
    sceneStore: { hit: () => null } as unknown as ElementSceneStore,
  });
  return { ...h, pointer: controller, screenPointer, coalesced, dispatch };
}

describe("active editor pointer and cursor composition", () => {
  it("routes idle hover to the scene reader without synchronous navigation, gesture, or UI dispatch", () => {
    const h = harness();
    for (let x = 100; x < 200; x += 1) {
      h.pointer.handlePointerMove(cursorPointerEvent({ clientX: x }));
    }
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.screenPointer).not.toHaveBeenCalled();
    expect(h.coalesced).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.read().cursor).toMatchObject({ x: 179, y: 50, kind: "tool" });
    expect(h.measure).toHaveBeenCalledOnce();
    h.controller.dispose();
  });

  it("preserves gesture input and the tool icon through drawing and commit", () => {
    const h = harness();
    h.pointer.handlePointerMove(cursorPointerEvent());
    expect(h.read().cursor?.kind).toBe("tool");
    h.pointer.handlePointerDown(cursorPointerEvent({ button: 0, buttons: 1, pressure: 0.5 }));
    expect(h.read()).toMatchObject({
      cursor: { kind: "tool", icon: h.toolIcon, x: 100, y: 50 },
      system: "crosshair",
    });
    h.pointer.handlePointerMove(cursorPointerEvent({ clientX: 150, buttons: 1, pressure: 0.5 }));
    expect(h.coalesced).toHaveBeenCalledOnce();
    expect(h.read().cursor).toMatchObject({ kind: "tool", icon: h.toolIcon, x: 130 });
    h.pointer.handlePointerUp(cursorPointerEvent({ clientX: 150 }));
    expect(h.controls.input.interaction).toBeUndefined();
    expect(h.read().cursor).toMatchObject({ kind: "tool", icon: h.toolIcon, x: 130 });
    h.pointer.handlePointerMove(cursorPointerEvent({ clientX: 150 }));
    expect(h.read().cursor).toMatchObject({ kind: "tool", icon: h.toolIcon, x: 130 });
    h.pointer.handlePointerMove(cursorPointerEvent({ clientX: 151 }));
    expect(h.read().cursor?.kind).toBe("tool");
    h.pointer.handlePointerCancel(cursorPointerEvent());
    expect(h.read()).toEqual({ cursor: null, system: "default" });
    h.controller.dispose();
  });

  it("clears feedback after unexpected capture loss and waits for fresh hover", () => {
    const h = harness();
    h.pointer.handlePointerDown(cursorPointerEvent({ button: 0, buttons: 1, pressure: 0.5 }));
    expect(h.controls.input.interaction?.phase).toBe("tool-gesture");
    h.pointer.handleLostPointerCapture(cursorPointerEvent());
    expect(h.controls.input.interaction).toBeUndefined();
    expect(h.read()).toEqual({ cursor: null, system: "default" });
    h.controller.refresh();
    expect(h.read()).toEqual({ cursor: null, system: "default" });
    h.pointer.handlePointerMove(cursorPointerEvent());
    expect(h.read().cursor?.kind).toBe("tool");
    h.controller.dispose();
  });
});
