import { describe, expect, it } from "vitest";

import { STARTUP_TOOLS } from "../../../../src/domain/settings/types";
import { createInputState, reduceInput } from "../../../../src/editor/input";
import {
  effectTypes,
  inputPhase,
  pointerDown,
  pointerMove,
} from "../../../fixtures/editor/input-actions";

describe("selection deselection", () => {
  it.each(["draw", "eraser", "line", "arrow", "rectangle"] as const)(
    "clears an existing selection before a primary %s gesture outside it",
    (activeTool) => {
      const started = reduceInput(
        createInputState({ activeTool, hasSelection: true }),
        pointerDown(),
      );
      expect(started.state.hasSelection).toBe(false);
      expect(effectTypes(started.effects)).toEqual([
        "capture-pointer",
        "clear-selection",
        "begin-preview",
      ]);
    },
  );

  it("still clears a Shift-modified drawing gesture outside the selection", () => {
    const started = reduceInput(
      createInputState({ activeTool: "draw", hasSelection: true }),
      pointerDown({ shift: true }),
    );
    expect(started.effects).toContainEqual({ type: "clear-selection" });
  });
});

describe("mouse and pen Select clicks", () => {
  it("clears an empty Select click on release", () => {
    const started = reduceInput(
      createInputState({ activeTool: "select", hasSelection: true }),
      pointerDown(),
    );
    const released = reduceInput(started.state, { type: "pointer-up", pointerId: 1 });
    expect(started.effects).toEqual([{ type: "capture-pointer", pointerId: 1 }]);
    expect(released.effects).toEqual([
      { type: "clear-selection" },
      { type: "release-pointer", pointerId: 1 },
    ]);
    expect(released.state.hasSelection).toBe(false);
  });

  it.each([
    ["plain", false, false, "replace"],
    ["Control or Command", true, false, "add"],
    ["Shift", false, true, "replace"],
  ] as const)(
    "selects an unselected element after a %s click",
    (_modifier, controlOrMeta, shift, mode) => {
      const started = reduceInput(
        createInputState({ activeTool: "select", hasSelection: true }),
        pointerDown({ controlOrMeta, shift, target: { elementId: "shape-b", isSelected: false } }),
      );
      expect(effectTypes(started.effects)).toEqual(["capture-pointer"]);
      const released = reduceInput(started.state, { type: "pointer-up", pointerId: 1 });
      expect(released.effects).toContainEqual({
        type: "select-element",
        elementId: "shape-b",
        mode,
      });
    },
  );

  it("clears for a normal pen outside but preserves its selected target", () => {
    const state = createInputState({ activeTool: "arrow", hasSelection: true });
    const outside = reduceInput(state, pointerDown({ pointerType: "pen" }));
    const selectedTarget = reduceInput(
      state,
      pointerDown({
        pointerType: "pen",
        target: { elementId: "shape-a", isSelected: true },
      }),
    );

    expect(effectTypes(outside.effects)).toEqual([
      "capture-pointer",
      "clear-selection",
      "begin-preview",
    ]);
    expect(effectTypes(selectedTarget.effects)).toEqual(["capture-pointer"]);
    expect(inputPhase(selectedTarget.state)).toBe("element-move");
    expect(selectedTarget.state.hasSelection).toBe(true);
  });
});

describe("touch selection deselection", () => {
  it("clears selection when a claimed finger drawing starts outside it", () => {
    const started = reduceInput(
      createInputState({
        activeTool: "draw",
        hasSelection: true,
        deviceFingerDrawingEnabled: true,
        toolbarFingerDrawingEnabled: true,
      }),
      pointerDown({ pointerType: "touch" }),
    );
    expect(started.state.hasSelection).toBe(false);
    expect(inputPhase(started.state)).toBe("tool-gesture");
    expect(effectTypes(started.effects)).toEqual([
      "capture-pointer",
      "clear-selection",
      "begin-preview",
    ]);

    const moved = reduceInput(started.state, pointerMove({ pointerType: "touch", x: 20, y: 24 }));
    expect(moved.state.hasSelection).toBe(false);
    expect(effectTypes(moved.effects)).toEqual(["update-preview"]);

    const committed = reduceInput(moved.state, { type: "pointer-up", pointerId: 1 });
    expect(committed.state.hasSelection).toBe(false);
    expect(effectTypes(committed.effects)).toEqual(["commit-preview", "release-pointer"]);
  });

  it("keeps selection when a claimed finger preview becomes a pinch", () => {
    const first = reduceInput(
      createInputState({
        activeTool: "draw",
        hasSelection: true,
        deviceFingerDrawingEnabled: true,
        toolbarFingerDrawingEnabled: true,
      }),
      pointerDown({ pointerType: "touch" }),
    );
    const moved = reduceInput(first.state, pointerMove({ pointerType: "touch", x: 20, y: 24 }));
    const pinch = reduceInput(
      moved.state,
      pointerDown({ pointerId: 2, pointerType: "touch", x: 30 }),
    );

    expect(pinch.state.hasSelection).toBe(false);
    expect(effectTypes(pinch.effects)).toEqual([
      "revert-preview",
      "capture-pointer",
      "begin-pinch",
    ]);
  });
});

describe("touch tap selection deselection", () => {
  it.each(STARTUP_TOOLS)(
    "selects an unselected element by touch tap while %s is active",
    (activeTool) => {
      const started = reduceInput(
        createInputState({
          activeTool,
          hasSelection: true,
          deviceFingerDrawingEnabled: true,
          toolbarFingerDrawingEnabled: true,
        }),
        pointerDown({
          pointerType: "touch",
          target: { elementId: "shape-b", isSelected: false },
        }),
      );

      expect(inputPhase(started.state)).toBe("touch-pending");
      expect(effectTypes(started.effects)).not.toContain("clear-selection");
      expect(
        reduceInput(started.state, { type: "pointer-up", pointerId: 1 }).effects,
      ).toContainEqual({
        type: "select-element",
        elementId: "shape-b",
        mode: "replace",
      });
    },
  );

  it("waits for a confirmed empty touch tap before clearing selection", () => {
    const pending = reduceInput(
      createInputState({ hasSelection: true }),
      pointerDown({ pointerType: "touch", timestamp: 100 }),
    );
    expect(effectTypes(pending.effects)).toEqual(["capture-pointer", "schedule-long-press"]);
    const moved = reduceInput(pending.state, pointerMove({ pointerType: "touch", x: 10, y: 31 }));
    expect(effectTypes(moved.effects)).toEqual(["cancel-long-press", "scroll-note"]);
    const released = reduceInput(moved.state, {
      type: "pointer-up",
      pointerId: 1,
      timestamp: 200,
    });
    expect(effectTypes(released.effects)).not.toContain("clear-selection");

    const tap = reduceInput(
      createInputState({ hasSelection: true }),
      pointerDown({ pointerType: "touch", timestamp: 100 }),
    );
    const tapped = reduceInput(tap.state, {
      type: "pointer-up",
      pointerId: 1,
      timestamp: 200,
    });
    expect(effectTypes(tapped.effects)).toEqual([
      "clear-selection",
      "cancel-long-press",
      "release-pointer",
    ]);
    expect(tapped.state.hasSelection).toBe(false);
  });
});
