import { describe, expect, it } from "vitest";
import {
  createInputState,
  inputPhase,
  reduceInput,
  type InputAction,
  type InputEffect,
  type InputState,
  type PointerMoveAction,
} from "../../../../src/editor/input";
import { pointerDown } from "../../../fixtures/editor/input-actions";
function pointerMove(overrides: Partial<PointerMoveAction> = {}): PointerMoveAction {
  return {
    type: "pointer-move",
    pointerId: 1,
    pointerType: "mouse",
    x: 20,
    y: 30,
    pressure: 0.5,
    ...overrides,
  };
}

function apply(state: InputState, action: InputAction) {
  return reduceInput(state, action);
}

function effectTypes(effects: readonly InputEffect[]): string[] {
  return effects.map(({ type }) => type);
}

describe("input arbitration", () => {
  it("starts with Draw and accepts only positive finite view configuration", () => {
    const initial = createInputState();
    expect(initial.activeTool).toBe("draw");
    expect(inputPhase(initial)).toBe("idle");

    const configured = apply(initial, {
      type: "configure",
      activeTool: "select",
      zoom: 2,
      fitZoom: 0,
    }).state;
    expect(configured).toMatchObject({ activeTool: "select", zoom: 2, fitZoom: 1 });
  });

  it("runs a primary mouse tool gesture as one preview transaction", () => {
    const started = apply(createInputState(), pointerDown());
    expect(inputPhase(started.state)).toBe("tool-gesture");
    expect(effectTypes(started.effects)).toEqual(["capture-pointer", "begin-preview"]);

    const moved = apply(started.state, pointerMove());
    expect(moved.effects).toEqual([
      {
        type: "update-preview",
        kind: "tool-gesture",
        pointer: {
          pointerId: 1,
          pointerType: "mouse",
          x: 20,
          y: 30,
          pressure: 0.5,
        },
      },
    ]);

    const released = apply(moved.state, { type: "pointer-up", pointerId: 1 });
    expect(inputPhase(released.state)).toBe("idle");
    expect(released.effects).toEqual([
      { type: "commit-preview", kind: "tool-gesture" },
      { type: "release-pointer", pointerId: 1 },
    ]);
  });

  it("reserves secondary buttons and platform context clicks before temporary Eraser", () => {
    const initial = createInputState({ activeTool: "draw" });
    const secondary = apply(initial, pointerDown({ button: 2, controlOrMeta: true }));
    const controlClick = apply(
      initial,
      pointerDown({ controlOrMeta: true, isPlatformContextClick: true }),
    );
    const auxiliary = apply(initial, pointerDown({ button: 1 }));
    const combined = apply(initial, pointerDown({ buttons: 3 }));

    expect(secondary).toEqual({ state: initial, effects: [] });
    expect(controlClick).toEqual({ state: initial, effects: [] });
    expect(auxiliary).toEqual({ state: initial, effects: [] });
    expect(combined).toEqual({ state: initial, effects: [] });
  });

  it("resolves pointer context-menu selection only when the target is unselected", () => {
    const initial = createInputState();
    const unselected = apply(initial, {
      type: "context-menu",
      source: "pointer",
      x: 4,
      y: 8,
      target: { elementId: "shape-a", isSelected: false },
    });
    expect(unselected.effects).toEqual([
      { type: "select-element", elementId: "shape-a", mode: "replace" },
      { type: "open-context-menu", source: "pointer", position: { x: 4, y: 8 } },
    ]);

    const selected = apply(initial, {
      type: "context-menu",
      source: "pointer",
      x: 4,
      y: 8,
      target: { elementId: "shape-a", isSelected: true },
    });
    const keyboard = apply(initial, {
      type: "context-menu",
      source: "keyboard",
      x: 5,
      y: 6,
      target: { elementId: "shape-b", isSelected: false },
    });
    expect(effectTypes(selected.effects)).toEqual(["open-context-menu"]);
    expect(effectTypes(keyboard.effects)).toEqual(["open-context-menu"]);
  });
});

describe("temporary tools and pointer priority", () => {
  it("temporarily activates Eraser for Ctrl/Cmd and restores the prior tool", () => {
    const initial = createInputState({ activeTool: "rectangle" });
    const started = apply(initial, pointerDown({ controlOrMeta: true }));
    expect(effectTypes(started.effects)).toEqual([
      "capture-pointer",
      "activate-temporary-eraser",
      "begin-preview",
    ]);
    expect(started.effects[1]).toEqual({
      type: "activate-temporary-eraser",
      previousTool: "rectangle",
    });

    const cancelled = apply(started.state, { type: "pointer-cancel", pointerId: 1 });
    expect(cancelled.effects).toEqual([
      { type: "revert-preview", kind: "eraser-gesture" },
      { type: "release-pointer", pointerId: 1 },
      { type: "restore-temporary-tool", tool: "rectangle" },
    ]);
  });

  it.each(["eraser", "side-button"] as const)(
    "temporarily activates Eraser for a pen %s",
    (penRole) => {
      const started = apply(
        createInputState({ activeTool: "line" }),
        pointerDown({ pointerType: "pen", penRole, button: 5 }),
      );
      expect(inputPhase(started.state)).toBe("eraser-gesture");
      expect(effectTypes(started.effects)).toEqual([
        "capture-pointer",
        "activate-temporary-eraser",
        "begin-preview",
      ]);
      const released = apply(started.state, { type: "pointer-up", pointerId: 1 });
      expect(released.effects[released.effects.length - 1]).toEqual({
        type: "restore-temporary-tool",
        tool: "line",
      });
    },
  );

  it("ignores non-finite pointer coordinates and pressure", () => {
    const initial = createInputState();
    expect(apply(initial, pointerDown({ x: Number.NaN }))).toEqual({
      state: initial,
      effects: [],
    });
    expect(apply(initial, pointerDown({ pressure: Number.POSITIVE_INFINITY }))).toEqual({
      state: initial,
      effects: [],
    });

    const started = apply(initial, pointerDown()).state;
    expect(apply(started, pointerMove({ y: Number.NEGATIVE_INFINITY }))).toEqual({
      state: started,
      effects: [],
    });
  });

  it("rejects coordinates outside the persisted geometry boundary without capture", () => {
    const initial = createInputState();
    expect(apply(initial, pointerDown({ x: 1_000_000.001 }))).toEqual({
      state: initial,
      effects: [],
    });
  });

  it("ignores touch palm input while a normal pen is active", () => {
    const pen = apply(createInputState(), pointerDown({ pointerType: "pen" }));
    const touch = apply(
      pen.state,
      pointerDown({ pointerId: 2, pointerType: "touch", pressure: 1 }),
    );
    expect(touch).toEqual({ state: pen.state, effects: [] });
  });

  it("lets a pen preempt and consume a pending touch", () => {
    const touch = apply(createInputState(), pointerDown({ pointerType: "touch", pressure: 1 }));
    const pen = apply(
      touch.state,
      pointerDown({ pointerId: 2, pointerType: "pen", pressure: 0.4 }),
    );
    expect(inputPhase(pen.state)).toBe("tool-gesture");
    expect(pen.state.consumedPointerIds).toEqual([1]);
    expect(effectTypes(pen.effects)).toEqual([
      "cancel-long-press",
      "release-pointer",
      "capture-pointer",
      "begin-preview",
    ]);
    expect(apply(pen.state, { type: "pointer-up", pointerId: 1 }).effects).toEqual([]);
  });
});

describe("touch state transitions", () => {
  it("opens an annotation long press only within 6 px and consumes its eventual release", () => {
    const started = apply(
      createInputState(),
      pointerDown({
        pointerType: "touch",
        target: { elementId: "shape-a", isSelected: true },
      }),
    );
    const moved = apply(started.state, pointerMove({ pointerType: "touch", x: 13, y: 24 }));
    const opened = apply(moved.state, { type: "long-press", pointerId: 1 });
    expect(inputPhase(opened.state)).toBe("idle");
    expect(opened.state.consumedPointerIds).toEqual([1]);
    expect(opened.effects).toEqual([
      { type: "cancel-long-press", pointerId: 1 },
      { type: "release-pointer", pointerId: 1 },
      { type: "open-context-menu", source: "touch", position: { x: 13, y: 24 } },
    ]);
    const released = apply(opened.state, { type: "pointer-up", pointerId: 1 });
    expect(released.state.consumedPointerIds).toEqual([]);
    expect(released.effects).toEqual([]);
  });

  it("keeps a motionless empty touch pending and opens its long press", () => {
    const started = apply(createInputState(), pointerDown({ pointerType: "touch" }));
    expect(inputPhase(started.state)).toBe("touch-pending");
    expect(started.effects[started.effects.length - 1]).toEqual({
      type: "schedule-long-press",
      pointerId: 1,
      delayMs: 500,
    });
    const moved = apply(started.state, pointerMove({ pointerType: "touch", x: 12, y: 23 }));
    expect(inputPhase(moved.state)).toBe("touch-pending");
    const opened = apply(moved.state, { type: "long-press", pointerId: 1 });
    expect(effectTypes(opened.effects)).toEqual([
      "cancel-long-press",
      "release-pointer",
      "open-context-menu",
    ]);
  });
});

describe("touch navigation and finger drawing", () => {
  it("reserves dominant horizontal touch for page pan at every zoom", () => {
    const zoomed = createInputState({ zoom: 2, fitZoom: 1 });
    const pending = apply(zoomed, pointerDown({ pointerType: "touch" }));
    const panned = apply(pending.state, pointerMove({ pointerType: "touch", x: 21, y: 22 }));
    expect(inputPhase(panned.state)).toBe("page-pan");
    expect(panned.effects).toEqual([
      { type: "cancel-long-press", pointerId: 1 },
      { type: "pan-page", screenDeltaX: 11 },
    ]);

    const fitPending = apply(
      createInputState({ zoom: 1, fitZoom: 1 }),
      pointerDown({ pointerType: "touch" }),
    );
    const scrolled = apply(fitPending.state, pointerMove({ pointerType: "touch", x: 21, y: 22 }));
    expect(inputPhase(scrolled.state)).toBe("page-pan");
    expect(scrolled.effects).toEqual([
      { type: "cancel-long-press", pointerId: 1 },
      { type: "pan-page", screenDeltaX: 11 },
    ]);
  });

  it.each([
    { x: 12, y: 31, label: "vertical" },
    { x: 21, y: 31, label: "non-dominant" },
  ])("routes $label movement to note scrolling", ({ x, y }) => {
    const pending = apply(
      createInputState({ zoom: 2, fitZoom: 1 }),
      pointerDown({ pointerType: "touch" }),
    );
    const moved = apply(pending.state, pointerMove({ pointerType: "touch", x, y }));
    expect(inputPhase(moved.state)).toBe("note-scroll");
    expect(effectTypes(moved.effects)).toEqual(["cancel-long-press", "scroll-note"]);
  });

  it("requires both finger-drawing controls before using the active tool", () => {
    const deviceOnly = createInputState({
      activeTool: "eraser",
      deviceFingerDrawingEnabled: true,
    });
    expect(inputPhase(apply(deviceOnly, pointerDown({ pointerType: "touch" })).state)).toBe(
      "touch-pending",
    );

    const enabled = createInputState({
      activeTool: "eraser",
      deviceFingerDrawingEnabled: true,
      toolbarFingerDrawingEnabled: true,
    });
    const started = apply(enabled, pointerDown({ pointerType: "touch" }));
    expect(inputPhase(started.state)).toBe("eraser-gesture");
    expect(effectTypes(started.effects)).toEqual(["capture-pointer", "begin-preview"]);
  });

  it.each([
    { deviceFingerDrawingEnabled: false, toolbarFingerDrawingEnabled: false },
    { deviceFingerDrawingEnabled: true, toolbarFingerDrawingEnabled: true },
  ])("uses Select as a thresholded additive touch area", (fingerSettings) => {
    const state = createInputState({ activeTool: "select", ...fingerSettings });
    const started = apply(state, pointerDown({ pointerType: "touch", shift: true }));
    expect(inputPhase(started.state)).toBe("lasso");
    const moved = apply(started.state, pointerMove({ pointerType: "touch", x: 17, y: 20 }));
    expect(moved.effects[0]).toMatchObject({
      type: "begin-preview",
      kind: "lasso",
      additive: true,
    });
  });
});

describe("multitouch pinch arbitration", () => {
  it("turns a second touch into midpoint pinch without releasing the first capture", () => {
    const first = apply(createInputState(), pointerDown({ pointerType: "touch" }));
    const pinch = apply(
      first.state,
      pointerDown({ pointerId: 2, pointerType: "touch", x: 30, y: 20 }),
    );
    expect(inputPhase(pinch.state)).toBe("pinch");
    expect(pinch.effects).toEqual([
      { type: "cancel-long-press", pointerId: 1 },
      { type: "capture-pointer", pointerId: 2 },
      { type: "begin-pinch", anchor: { x: 20, y: 20 }, pointers: [1, 2] },
    ]);

    const moved = apply(
      pinch.state,
      pointerMove({ pointerId: 2, pointerType: "touch", x: 40, y: 20 }),
    );
    expect(moved.effects).toEqual([
      { type: "update-pinch", anchor: { x: 25, y: 20 }, factor: 1.5 },
    ]);
    const finished = apply(moved.state, { type: "pointer-up", pointerId: 2 });
    expect(effectTypes(finished.effects)).toEqual([
      "finish-pinch",
      "release-pointer",
      "release-pointer",
    ]);
    expect(finished.state.consumedPointerIds).toEqual([1]);
  });

  it("reverts pinch and consumes the remaining pointer on cancellation", () => {
    const first = apply(createInputState(), pointerDown({ pointerType: "touch" }));
    const pinch = apply(first.state, pointerDown({ pointerId: 2, pointerType: "touch", x: 30 }));
    const cancelled = apply(pinch.state, { type: "lost-pointer-capture", pointerId: 1 });
    expect(effectTypes(cancelled.effects)).toEqual([
      "revert-pinch",
      "release-pointer",
      "release-pointer",
    ]);
    expect(cancelled.state.consumedPointerIds).toEqual([2]);
  });
});

describe("selection and cancellation", () => {
  it("resets interaction state so input can restart after disable and re-enable", () => {
    const started = apply(createInputState(), pointerDown());
    const reset = apply(started.state, { type: "reset" });

    expect(reset.state.interaction).toBeUndefined();
    expect(reset.state.consumedPointerIds).toEqual([]);
    expect(effectTypes(reset.effects)).toEqual(["revert-preview", "release-pointer"]);

    const restarted = apply(reset.state, pointerDown());
    expect(inputPhase(restarted.state)).toBe("tool-gesture");
    expect(effectTypes(restarted.effects)).toEqual(["capture-pointer", "begin-preview"]);
  });

  it("uses element move only while Select is active for mouse and pen", () => {
    const target = { elementId: "shape-a", isSelected: false };
    const draw = apply(createInputState(), pointerDown({ target }));
    expect(inputPhase(draw.state)).toBe("tool-gesture");

    const select = apply(createInputState({ activeTool: "select" }), pointerDown({ target }));
    expect(inputPhase(select.state)).toBe("element-move");
    expect(select.effects[1]).toEqual({
      type: "select-element",
      elementId: "shape-a",
      mode: "replace",
    });
  });

  it("clears selection on an empty Select click but preserves it for Shift", () => {
    const state = createInputState({ activeTool: "select", hasSelection: true });
    const click = apply(state, pointerDown());
    const released = apply(click.state, { type: "pointer-up", pointerId: 1 });
    expect(click.effects).toContainEqual({ type: "clear-selection" });
    expect(released.effects).toEqual([{ type: "release-pointer", pointerId: 1 }]);

    const additive = apply(state, pointerDown({ shift: true }));
    expect(apply(additive.state, { type: "pointer-up", pointerId: 1 }).effects).toEqual([
      { type: "release-pointer", pointerId: 1 },
    ]);
  });

  it.each(["pointer-cancel", "lost-pointer-capture"] as const)(
    "reverts an uncommitted preview on %s",
    (type) => {
      const started = apply(createInputState(), pointerDown());
      const cancelled = apply(started.state, { type, pointerId: 1 });
      expect(cancelled.effects).toEqual([
        { type: "revert-preview", kind: "tool-gesture" },
        { type: "release-pointer", pointerId: 1 },
      ]);
      expect(inputPhase(cancelled.state)).toBe("idle");
    },
  );

  it("restores navigation on cancellation without creating a preview commit", () => {
    const pending = apply(
      createInputState({ zoom: 2, fitZoom: 1 }),
      pointerDown({ pointerType: "touch" }),
    );
    const panning = apply(pending.state, pointerMove({ pointerType: "touch", x: 30, y: 20 }));
    const cancelled = apply(panning.state, { type: "pointer-cancel", pointerId: 1 });
    expect(cancelled.effects).toEqual([
      { type: "revert-navigation", kind: "page-pan" },
      { type: "release-pointer", pointerId: 1 },
    ]);
  });

  it("ignores exits from unrelated pointers", () => {
    const started = apply(createInputState(), pointerDown());
    expect(apply(started.state, { type: "pointer-up", pointerId: 99 })).toEqual({
      state: started.state,
      effects: [],
    });
  });
});
