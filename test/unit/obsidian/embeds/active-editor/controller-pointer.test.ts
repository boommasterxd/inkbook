import { describe, expect, it, vi } from "vitest";

import { ActiveEditorPointerController } from "../../../../../src/obsidian/embeds/active-editor/controller-pointer";
import type { CoalescedPointerInput } from "../../../../../src/obsidian/embeds/active-editor/coalesced-input";
import type { ActiveEditorHandleInteraction } from "../../../../../src/obsidian/embeds/active-editor/handle-interaction";
import type { ActiveEditorMenuController } from "../../../../../src/obsidian/embeds/active-editor/controller-menu";
import type { ActiveEditorNavigation } from "../../../../../src/obsidian/embeds/active-editor/navigation";
import type { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene/index";
import { createInputState, type InputState } from "../../../../../src/editor/input/index";

describe("active editor pointer controller", () => {
  it("uses screen pixels for arbitration and page coordinates for indexed hit testing", () => {
    const dispatch = vi.fn();
    const hit = vi.fn(() => null);
    const setLastPointer = vi.fn();
    const interruptForInput = vi.fn();
    const navigation = navigationPort();
    const controller = new ActiveEditorPointerController({
      beginHandlePointer: vi.fn(),
      capturePointer: vi.fn(),
      coalesced: {} as CoalescedPointerInput,
      dispatch,
      finishHandlePointer: vi.fn(),
      getInput: () => createInputState(),
      handles: handlesPort(false),
      interruptForInput,
      isEnabled: () => true,
      menus: menuPort(),
      navigation: navigation.value,
      ownerWindow: { navigator: { platform: "Linux" } } as unknown as Window,
      renderer: rendererPort(),
      releasePointer: vi.fn(),
      sceneStore: { hit } as unknown as ElementSceneStore,
      selection: () => new Set(),
      setLastPointer,
    });

    controller.handlePointerDown(pointerEvent());

    expect(navigation.begin).toHaveBeenCalledOnce();
    expect(interruptForInput).toHaveBeenCalledOnce();
    expect(interruptForInput.mock.invocationCallOrder[0]).toBeLessThan(
      navigation.begin.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(hit).toHaveBeenCalledWith(expect.objectContaining({ x: 120, y: 130 }), "mouse", 2);
    expect(setLastPointer).toHaveBeenCalledWith(
      expect.objectContaining({ pointerId: 7, x: 120, y: 130 }),
      expect.objectContaining({ pointerId: 7, x: 20, y: 30 }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ pointerId: 7, type: "pointer-down", x: 20, y: 30 }),
    );
  });

  it("balances direct handle capture with navigation and pen-scroll lifecycle", () => {
    const beginHandlePointer = vi.fn();
    const finishHandlePointer = vi.fn();
    const surface = rendererPort().inputSurface;
    const capturePointer = vi.fn((pointerId: number) => surface.setPointerCapture(pointerId));
    const releasePointer = vi.fn((pointerId: number) => surface.releasePointerCapture(pointerId));
    const controller = new ActiveEditorPointerController({
      beginHandlePointer,
      capturePointer,
      coalesced: {} as CoalescedPointerInput,
      dispatch: vi.fn(),
      finishHandlePointer,
      getInput: () => createInputState(),
      handles: handlesPort(true),
      interruptForInput: vi.fn(),
      isEnabled: () => true,
      menus: menuPort(),
      navigation: navigationPort().value,
      ownerWindow: { navigator: { platform: "Linux" } } as unknown as Window,
      renderer: {
        inputSurface: surface,
        interruptMotionForPointerDown: vi.fn(),
      } as unknown as SvgSceneRenderer,
      releasePointer,
      sceneStore: { hit: vi.fn(() => null) } as unknown as ElementSceneStore,
      selection: () => new Set(),
      setLastPointer: vi.fn(),
    });

    controller.handlePointerDown(pointerEvent("pen"));
    controller.handlePointerUp(pointerEvent("pen"));

    expect(beginHandlePointer).toHaveBeenCalledWith("pen");
    expect(capturePointer).toHaveBeenCalledWith(7);
    expect(releasePointer).toHaveBeenCalledWith(7);
    expect(finishHandlePointer).toHaveBeenCalledOnce();
  });
});

describe("active editor pointer gesture ownership", () => {
  it("stops a claimed horizontal touch pan before it reaches Obsidian", () => {
    const controller = horizontalPanController();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = pointerEvent("touch", { preventDefault, stopPropagation });

    controller.handlePointerMove(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("leaves dominant vertical touch movement available to native scrolling", () => {
    const interaction = { ...pagePanInteraction(), phase: "note-scroll" as const };
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const controller = horizontalPanController({
      getInput: () => ({ ...createInputState(), interaction }),
    });

    controller.handlePointerMove(pointerEvent("touch", { preventDefault, stopPropagation }));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();

    controller.handlePointerUp(pointerEvent("touch", { preventDefault, stopPropagation }));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});

describe("active editor pointer momentum", () => {
  it("records touch pan velocity and releases it into momentum", () => {
    let input = { ...createInputState({ fitZoom: 1, zoom: 2 }), interaction: pagePanInteraction() };
    const navigation = navigationPort();
    const controller = horizontalPanController({
      coalescedDispatch: () => {
        input = {
          ...input,
          interaction: { ...pagePanInteraction(), current: { x: 32, y: 30 } },
        };
        return true;
      },
      getInput: () => input,
      navigation: navigation.value,
    });

    controller.handlePointerMove(pointerEvent("touch", { timeStamp: 24 }));
    controller.handlePointerUp(pointerEvent("touch", { timeStamp: 32 }));

    expect(navigation.recordTouchPan.mock.calls[0]?.[0]).toBeCloseTo(14.4);
    expect(navigation.recordTouchPan.mock.calls[0]?.[1]).toBe(24);
    expect(navigation.releaseTouchPan).toHaveBeenCalledWith(32);
  });
});

describe("active editor pointer recovery", () => {
  it("releases a stale captured pointer during terminal recovery", () => {
    const releasePointer = vi.fn();
    const dispatch = vi.fn();
    const controller = horizontalPanController({ dispatch, releasePointer });

    controller.cancelPointer(7);

    expect(dispatch).toHaveBeenCalledWith({ pointerId: 7, type: "pointer-cancel" });
    expect(releasePointer).toHaveBeenCalledWith(7);
  });
});

function navigationPort() {
  const begin = vi.fn(() => true);
  const cancelPanMomentum = vi.fn();
  const recordTouchPan = vi.fn();
  const releaseTouchPan = vi.fn();
  return {
    begin,
    cancelPanMomentum,
    recordTouchPan,
    releaseTouchPan,
    value: {
      beginGestureGeometry: begin,
      cancelPanMomentum,
      pageSample: (sample: { readonly x: number; readonly y: number }) => ({
        ...sample,
        x: sample.x + 100,
        y: sample.y + 100,
      }),
      screenPointer: (event: PointerEvent) => ({
        pointerId: 7,
        pointerType: event.pointerType,
        pressure: 0.5,
        x: 20,
        y: 30,
      }),
      recordTouchPan,
      releaseTouchPan,
      zoom: 2,
    } as unknown as ActiveEditorNavigation,
  };
}

function horizontalPanController(overrides?: {
  readonly coalescedDispatch?: (event: PointerEvent) => boolean;
  readonly dispatch?: (action: unknown) => void;
  readonly getInput?: () => InputState;
  readonly navigation?: ActiveEditorNavigation;
  readonly releasePointer?: (pointerId: number) => void;
}): ActiveEditorPointerController {
  const input = createInputState({ zoom: 2, fitZoom: 1 });
  return new ActiveEditorPointerController({
    beginHandlePointer: vi.fn(),
    capturePointer: vi.fn(),
    coalesced: {
      dispatch: vi.fn(overrides?.coalescedDispatch ?? (() => true)),
    } as unknown as CoalescedPointerInput,
    dispatch: overrides?.dispatch ?? vi.fn(),
    finishHandlePointer: vi.fn(),
    getInput: overrides?.getInput ?? (() => ({ ...input, interaction: pagePanInteraction() })),
    handles: handlesPort(false),
    interruptForInput: vi.fn(),
    isEnabled: () => true,
    menus: menuPort(),
    navigation: overrides?.navigation ?? navigationPort().value,
    ownerWindow: { navigator: { platform: "Linux" } } as unknown as Window,
    renderer: rendererPort(),
    releasePointer: overrides?.releasePointer ?? vi.fn(),
    sceneStore: { hit: vi.fn(() => null) } as unknown as ElementSceneStore,
    selection: () => new Set(),
    setLastPointer: vi.fn(),
  });
}

function pagePanInteraction() {
  return {
    current: { x: 20, y: 30 },
    longPressScheduled: false,
    penRole: "normal" as const,
    phase: "page-pan" as const,
    pointerId: 7,
    pointerType: "touch" as const,
    previewStarted: false,
    previousTool: "draw" as const,
    shift: false,
    start: { x: 10, y: 30 },
    temporaryEraser: false,
    tool: "draw" as const,
  };
}

function handlesPort(active: boolean): ActiveEditorHandleInteraction {
  return {
    cancel: vi.fn(() => active),
    pointerDown: vi.fn(() => active),
    pointerMove: vi.fn(() => active),
    pointerUp: vi.fn(() => active),
  } as unknown as ActiveEditorHandleInteraction;
}

function menuPort(): ActiveEditorMenuController {
  return {
    dispatchFromEvent: (_event: MouseEvent | undefined, dispatch: () => void) => dispatch(),
  } as ActiveEditorMenuController;
}

function rendererPort(): SvgSceneRenderer {
  return {
    interruptMotionForPointerDown: vi.fn(),
    inputSurface: {
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    },
  } as unknown as SvgSceneRenderer;
}

function pointerEvent(
  pointerType = "mouse",
  overrides: Partial<Pick<PointerEvent, "preventDefault" | "stopPropagation" | "timeStamp">> = {},
): PointerEvent {
  return {
    button: 0,
    buttons: 1,
    ctrlKey: false,
    isPrimary: true,
    metaKey: false,
    pointerId: 7,
    pointerType,
    preventDefault: overrides.preventDefault ?? vi.fn(),
    stopPropagation: overrides.stopPropagation ?? vi.fn(),
    shiftKey: false,
    timeStamp: overrides.timeStamp ?? 16,
  } as unknown as PointerEvent;
}
