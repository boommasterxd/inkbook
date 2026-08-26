import { describe, expect, it } from "vitest";

import { createInputState, reduceInput } from "../../../../src/editor/input/index";

const touchDown = {
  type: "pointer-down" as const,
  pointerId: 1,
  pointerType: "touch" as const,
  x: 10,
  y: 20,
  pressure: 0.5,
  button: 0,
  buttons: 1,
  controlOrMeta: false,
  shift: false,
  isPlatformContextClick: false,
};

describe("touch scrolling from an annotation", () => {
  it("selects on contact but yields a dominant vertical move before dragging", () => {
    const started = reduceInput(createInputState({ activeTool: "draw" }), {
      ...touchDown,
      target: { elementId: "stroke-a", isSelected: false },
    });
    const scrolled = reduceInput(started.state, {
      type: "pointer-move",
      pointerId: 1,
      pointerType: "touch",
      x: 12,
      y: 30,
    });

    expect(started.effects).toContainEqual({
      type: "select-element",
      elementId: "stroke-a",
      mode: "preserve-or-replace",
    });
    expect(scrolled.state.interaction?.phase).toBe("note-scroll");
    expect(scrolled.effects.map(({ type }) => type)).toEqual(["cancel-long-press", "scroll-note"]);
  });

  it("keeps a non-vertical annotation gesture as element movement", () => {
    const started = reduceInput(createInputState(), {
      ...touchDown,
      target: { elementId: "stroke-a", isSelected: true },
    });
    const moved = reduceInput(started.state, {
      type: "pointer-move",
      pointerId: 1,
      pointerType: "touch",
      x: 18,
      y: 23,
    });

    expect(moved.state.interaction?.phase).toBe("element-move");
    expect(moved.effects.map(({ type }) => type)).toEqual(["cancel-long-press", "begin-preview"]);
  });
});
