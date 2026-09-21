import { describe, expect, it, vi } from "vitest";

import { ActiveEditorPointerController } from "../../../../../src/obsidian/embeds/active-editor/controller-pointer";
import type { CoalescedPointerInput } from "../../../../../src/obsidian/embeds/active-editor/coalesced-input";
import type { ActiveEditorHandleInteraction } from "../../../../../src/obsidian/embeds/active-editor/handle-interaction";
import type { ActiveEditorMenuController } from "../../../../../src/obsidian/embeds/active-editor/controller-menu";
import type { ActiveEditorNavigation } from "../../../../../src/obsidian/embeds/active-editor/navigation";
import type { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene/index";
import {
  createInputState,
  reduceInput,
  type InputAction,
  type InputState,
} from "../../../../../src/editor/input/index";

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

describe("active editor temporary snapping modifier", () => {
  it.each([
    ["pen", 0, 0, false],
    ["pen", 0.2, 0, true],
    ["pen", 0, 1, true],
    ["mouse", 0, 0, true],
    ["touch", 0, 0, true],
  ] as const)(
    "finishes %s handles at the last contact when pressure=%s buttons=%s",
    (pointerType, pressure, buttons, acceptsReleasePosition) => {
      const pointerMove = vi.fn(() => true);
      const pointerUp = vi.fn(() => true);
      const finishHandlePointer = vi.fn();
      const releasePointer = vi.fn();
      const controller = horizontalPanController({
        finishHandlePointer,
        releasePointer,
        handles: { pointerMove, pointerUp } as unknown as ActiveEditorHandleInteraction,
      });
      controller.handlePointerUp(
        Object.assign(pointerEvent(pointerType), { pressure, buttons, clientX: 400, clientY: 500 }),
      );
      expect(pointerMove).toHaveBeenCalledTimes(acceptsReleasePosition ? 1 : 0);
      expect(pointerUp).toHaveBeenCalledExactlyOnceWith(7);
      expect(finishHandlePointer).toHaveBeenCalledOnce();
      expect(releasePointer).toHaveBeenCalledExactlyOnceWith(7);
    },
  );

  it("forwards Alt changes to handles and clears the override at gesture end", () => {
    const pointerDown = vi.fn(() => true);
    const pointerMove = vi.fn(() => true);
    const handles = {
      cancel: vi.fn(() => true),
      pointerDown,
      pointerMove,
      pointerUp: vi.fn(() => true),
    } as unknown as ActiveEditorHandleInteraction;
    const setSnappingInverted = vi.fn();
    const controller = horizontalPanController({ handles, setSnappingInverted });

    controller.handlePointerDown(pointerEvent("mouse", { altKey: true }));
    controller.handlePointerMove(pointerEvent("mouse", { altKey: false }));
    controller.handlePointerUp(pointerEvent("mouse", { altKey: true }));

    expect(pointerDown).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(pointerMove).toHaveBeenNthCalledWith(1, expect.anything(), false, false);
    expect(pointerMove).toHaveBeenNthCalledWith(2, expect.anything(), false, true);
    expect(setSnappingInverted).toHaveBeenLastCalledWith(7, null);
  });
});

describe("selection handle pointer cancellation", () => {
  it("does not cancel a non-cancelable touch move owned by a selection handle", () => {
    const preventDefault = vi.fn();
    const controller = horizontalPanController({ handles: handlesPort(true) });

    controller.handlePointerMove(pointerEvent("touch", { cancelable: false, preventDefault }));

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("routes lost pointer capture through handle cancellation and pointer cleanup", () => {
    const cancel = vi.fn(() => true);
    const handles = { ...handlesPort(true), cancel } as unknown as ActiveEditorHandleInteraction;
    const releasePointer = vi.fn();
    const finishHandlePointer = vi.fn();
    const controller = horizontalPanController({
      finishHandlePointer,
      handles,
      releasePointer,
    });

    controller.handleLostPointerCapture(pointerEvent());

    expect(cancel).toHaveBeenCalledWith(7);
    expect(releasePointer).toHaveBeenCalledWith(7);
    expect(finishHandlePointer).toHaveBeenCalledOnce();
  });
});

describe("active editor pointer gesture ownership", () => {
  it("keeps foreign touch lifecycle out of the reducer during a pen handle drag", () => {
    let owner: number | undefined = 7;
    let input = createInputState();
    const dispatch = vi.fn((action: unknown) => {
      input = reduceInput(input, action as InputAction).state;
    });
    const pointerMove = vi.fn(() => true);
    const pointerUp = vi.fn(() => {
      owner = undefined;
      return true;
    });
    const cancel = vi.fn(() => false);
    const handles = {
      ...handlesPort(false),
      cancel,
      get activePointerId() {
        return owner;
      },
      pointerMove,
      pointerUp,
    } as unknown as ActiveEditorHandleInteraction;
    const navigation = navigationPort();
    const controller = horizontalPanController({
      dispatch,
      getInput: () => input,
      handles,
      navigation: navigation.value,
    });
    const foreign = Object.assign(pointerEvent("touch"), { pointerId: 8 });

    controller.handlePointerDown(foreign);
    controller.handlePointerMove(foreign);
    controller.handlePointerUp(foreign);
    controller.handlePointerCancel(foreign);
    controller.handleLostPointerCapture(foreign);

    expect(input.interaction).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(navigation.begin).not.toHaveBeenCalled();
    expect(navigation.cancelPanMomentum).not.toHaveBeenCalled();
    expect(pointerMove).not.toHaveBeenCalled();
    expect(pointerUp).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    controller.handlePointerMove(pointerEvent("pen"));
    controller.handlePointerUp(pointerEvent("pen"));
    expect(pointerMove).toHaveBeenCalled();
    expect(pointerUp).toHaveBeenCalledExactlyOnceWith(7);
    controller.handlePointerDown(foreign);
    expect(input.interaction).toMatchObject({ pointerId: 8, phase: "touch-pending" });
    controller.handlePointerDown(Object.assign(pointerEvent("touch"), { pointerId: 9 }));
    expect(input.interaction).toMatchObject({ phase: "pinch" });
  });

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
        pointerId: event.pointerId,
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
  readonly finishHandlePointer?: () => void;
  readonly getInput?: () => InputState;
  readonly handles?: ActiveEditorHandleInteraction;
  readonly navigation?: ActiveEditorNavigation;
  readonly releasePointer?: (pointerId: number) => void;
  readonly setSnappingInverted?: (pointerId: number, inverted: boolean | null) => void;
}): ActiveEditorPointerController {
  const input = createInputState({ zoom: 2, fitZoom: 1 });
  return new ActiveEditorPointerController({
    beginHandlePointer: vi.fn(),
    capturePointer: vi.fn(),
    coalesced: {
      dispatch: vi.fn(overrides?.coalescedDispatch ?? (() => true)),
    } as unknown as CoalescedPointerInput,
    dispatch: overrides?.dispatch ?? vi.fn(),
    finishHandlePointer: overrides?.finishHandlePointer ?? vi.fn(),
    getInput: overrides?.getInput ?? (() => ({ ...input, interaction: pagePanInteraction() })),
    handles: overrides?.handles ?? handlesPort(false),
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
    ...(overrides?.setSnappingInverted === undefined
      ? {}
      : { setSnappingInverted: overrides.setSnappingInverted }),
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
      focus: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    },
  } as unknown as SvgSceneRenderer;
}

function pointerEvent(
  pointerType = "mouse",
  overrides: Partial<
    Pick<PointerEvent, "altKey" | "cancelable" | "preventDefault" | "stopPropagation" | "timeStamp">
  > = {},
): PointerEvent {
  return {
    button: 0,
    buttons: 1,
    altKey: overrides.altKey ?? false,
    cancelable: overrides.cancelable ?? true,
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
