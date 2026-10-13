import { describe, expect, it } from "vitest";
import { createInputState, reduceInput } from "../../../../src/editor/input";
import type { PointerDownAction } from "../../../../src/editor/input/input-types";
import { effectTypes, pointerDown, pointerMove } from "../../../fixtures/editor/input-actions";

function penPress(target?: PointerDownAction["target"]) {
  return reduceInput(
    createInputState({ activeTool: target?.isSelected ? "arrow" : "select", hasSelection: true }),
    pointerDown({ pointerType: "pen", ...(target === undefined ? {} : { target }) }),
  );
}

describe("normal pen long press", () => {
  it.each(["selected", "unselected", "empty"] as const)(
    "opens a %s context menu after the scheduled 500 ms with six pixels of jitter",
    (kind) => {
      const target =
        kind === "empty" ? undefined : { elementId: "shape-a", isSelected: kind === "selected" };
      const started = penPress(target);
      expect(started.effects).toEqual([
        { type: "capture-pointer", pointerId: 1 },
        { type: "schedule-long-press", pointerId: 1, delayMs: 500 },
      ]);
      const moved = reduceInput(started.state, pointerMove({ pointerType: "pen", x: 16, y: 20 }));
      expect(moved.effects).toEqual([]);
      const opened = reduceInput(moved.state, { type: "long-press", pointerId: 1 });
      expect(opened.effects).toEqual([
        { type: "cancel-long-press", pointerId: 1 },
        { type: "release-pointer", pointerId: 1 },
        ...(kind === "unselected"
          ? [{ type: "select-element", elementId: "shape-a", mode: "replace" }]
          : []),
        { type: "open-context-menu", source: "pointer", position: { x: 16, y: 20 } },
      ]);
      expect(opened.state.interaction).toBeUndefined();
      expect(opened.state.hasSelection).toBe(true);
      expect(opened.state.consumedPointerIds).toEqual([1]);
      expect(reduceInput(opened.state, { type: "long-press", pointerId: 1 }).effects).toEqual([]);
      expect(reduceInput(opened.state, { type: "lost-pointer-capture", pointerId: 1 }).state).toBe(
        opened.state,
      );
      const released = reduceInput(opened.state, { type: "pointer-up", pointerId: 1 });
      expect(released.effects).toEqual([{ type: "release-pointer", pointerId: 1 }]);
      expect(released.state.consumedPointerIds).toEqual([]);
    },
  );

  it.each([false, true])("adopts a resolved pending target with selected=%s", (isSelected) => {
    const started = penPress();
    const opened = reduceInput(started.state, {
      type: "long-press",
      pointerId: 1,
      target: { elementId: "resolved", isSelected },
    });
    expect(effectTypes(opened.effects)).toEqual(
      isSelected
        ? ["cancel-long-press", "release-pointer", "open-context-menu"]
        : ["cancel-long-press", "release-pointer", "select-element", "open-context-menu"],
    );
    if (!isSelected)
      expect(opened.effects[2]).toMatchObject({ elementId: "resolved", mode: "replace" });
  });
});

describe("pen long-press cancellation", () => {
  it.each([
    [false, 16.001, undefined],
    [true, 16.001, undefined],
    [false, 10, 6.001],
    [true, 10, 6.001],
  ] as const)(
    "cancels the timer when selected=%s drag to x=%s wins with batch excursion=%s",
    (isSelected, x, maximumMovement) => {
      const started = penPress(isSelected ? { elementId: "shape-a", isSelected } : undefined);
      const moved = reduceInput(
        started.state,
        pointerMove({
          pointerType: "pen",
          x,
          y: 20,
          ...(maximumMovement === undefined ? {} : { maximumMovement }),
        }),
      );
      expect(effectTypes(moved.effects)).toEqual(
        isSelected
          ? ["cancel-long-press", "begin-preview", "update-preview"]
          : ["clear-selection", "cancel-long-press", "begin-preview", "update-preview"],
      );
      expect(reduceInput(moved.state, { type: "long-press", pointerId: 1 })).toEqual({
        state: moved.state,
        effects: [],
      });
      const cancelled = reduceInput(moved.state, { type: "pointer-cancel", pointerId: 1 });
      expect(effectTypes(cancelled.effects)).toEqual(["revert-preview", "release-pointer"]);
    },
  );

  it.each(["pointer-up", "pointer-cancel", "lost-pointer-capture", "reset"] as const)(
    "cleans a pending pen timer on %s",
    (type) => {
      const started = penPress();
      const ended = reduceInput(started.state, { type, pointerId: 1 });
      expect(effectTypes(ended.effects)).toEqual(
        type === "pointer-up"
          ? ["clear-selection", "cancel-long-press", "release-pointer"]
          : ["cancel-long-press", "release-pointer"],
      );
      expect(ended.state.interaction).toBeUndefined();
      expect(reduceInput(ended.state, { type: "long-press", pointerId: 1 }).effects).toEqual([]);
    },
  );

  it.each(["eraser", "side-button"] as const)(
    "does not arm a context timer for the %s pen role",
    (penRole) => {
      const started = reduceInput(
        createInputState({ activeTool: "select" }),
        pointerDown({ pointerType: "pen", penRole }),
      );
      expect(effectTypes(started.effects)).toEqual(["capture-pointer"]);
      expect(reduceInput(started.state, { type: "long-press", pointerId: 1 }).effects).toEqual([]);
    },
  );

  it("keeps a temporary eraser on a selected annotation destructive", () => {
    const started = reduceInput(
      createInputState({ activeTool: "draw", hasSelection: true }),
      pointerDown({
        pointerType: "pen",
        controlOrMeta: true,
        target: { elementId: "shape-a", isSelected: true },
      }),
    );
    expect(started.state.interaction?.phase).toBe("eraser-gesture");
    expect(effectTypes(started.effects)).toEqual([
      "capture-pointer",
      "activate-temporary-eraser",
      "begin-preview",
    ]);
    expect(reduceInput(started.state, { type: "long-press", pointerId: 1 }).effects).toEqual([]);
  });
});
