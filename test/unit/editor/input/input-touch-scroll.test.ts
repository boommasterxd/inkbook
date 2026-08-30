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

function releaseTargetTapAt(timestamp: number) {
  const started = reduceInput(createInputState(), {
    ...touchDown,
    timestamp: 100,
    target: { elementId: "stroke-a", isSelected: false },
  });
  return reduceInput(started.state, { type: "pointer-up", pointerId: 1, timestamp });
}

describe("touch arbitration over an annotation", () => {
  it("routes a vertical move without selecting an unselected annotation", () => {
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

    expect(started.effects.map(({ type }) => type)).toEqual([
      "capture-pointer",
      "schedule-long-press",
    ]);
    expect(scrolled.state.interaction?.phase).toBe("note-scroll");
    expect(scrolled.effects.map(({ type }) => type)).toEqual(["cancel-long-press", "scroll-note"]);
    expect([...started.effects, ...scrolled.effects].map(({ type }) => type)).not.toContain(
      "select-element",
    );
  });

  it.each([
    { x: -1, y: 20, phase: "page-pan" },
    { x: 21, y: 20, phase: "page-pan" },
    { x: 10, y: 9, phase: "note-scroll" },
    { x: 10, y: 31, phase: "note-scroll" },
  ] as const)("does not select while routing $phase movement to $x,$y", ({ x, y, phase }) => {
    const started = reduceInput(createInputState({ zoom: 2, fitZoom: 1 }), {
      ...touchDown,
      target: { elementId: "stroke-a", isSelected: false },
    });
    const moved = reduceInput(started.state, {
      type: "pointer-move",
      pointerId: 1,
      pointerType: "touch",
      x,
      y,
    });

    expect(moved.state.interaction?.phase).toBe(phase);
    expect([...started.effects, ...moved.effects].map(({ type }) => type)).not.toContain(
      "select-element",
    );
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
    expect(moved.effects.map(({ type }) => type)).toEqual([
      "cancel-long-press",
      "begin-preview",
      "update-preview",
    ]);
  });
});

describe("touch tap classification", () => {
  it("does not turn a slow stationary release into a tap selection", () => {
    const released = releaseTargetTapAt(450);

    expect(released.effects.map(({ type }) => type)).not.toContain("select-element");
  });

  it("selects an unselected annotation on a short stationary tap", () => {
    const released = releaseTargetTapAt(449);

    expect(released.effects[0]).toEqual({
      type: "select-element",
      elementId: "stroke-a",
      mode: "preserve-or-replace",
    });
  });

  it("rejects the exact tap duration and movement boundaries", () => {
    const durationEnd = releaseTargetTapAt(450);
    const movementStart = reduceInput(createInputState(), {
      ...touchDown,
      timestamp: 100,
      target: { elementId: "stroke-a", isSelected: false },
    });
    const movement = reduceInput(movementStart.state, {
      type: "pointer-move",
      pointerId: 1,
      pointerType: "touch",
      x: 13.6,
      y: 24.8,
    });
    const movementEnd = reduceInput(movement.state, {
      type: "pointer-up",
      pointerId: 1,
      timestamp: 200,
    });

    expect(durationEnd.effects.map(({ type }) => type)).not.toContain("select-element");
    expect(movementEnd.effects.map(({ type }) => type)).not.toContain("select-element");
  });
});
