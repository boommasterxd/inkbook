import { describe, expect, it } from "vitest";

import { createInputState, reduceInput } from "../../../../src/editor/input/index";
import { effectTypes, pointerDown, pointerMove } from "../../../fixtures/editor/input-actions";

const secondary = pointerDown({ button: 2, buttons: 2, isPlatformContextClick: true });

describe("secondary mouse navigation", () => {
  it("defers selection and menus through the exact six CSS pixel boundary", () => {
    const initial = createInputState({ activeTool: "draw", hasSelection: true, zoom: 3 });
    const started = reduceInput(initial, {
      ...secondary,
      target: { elementId: "shape-a", isSelected: false },
    });
    expect(started.state.interaction?.phase).toBe("secondary-pending");
    expect(started.effects).toEqual([{ type: "capture-pointer", pointerId: 1 }]);
    const jitter = reduceInput(started.state, pointerMove({ x: 16, y: 20 }));
    expect(jitter.state.hasSelection).toBe(true);
    expect(jitter.effects).toEqual([]);
    const released = reduceInput(jitter.state, { type: "pointer-up", pointerId: 1 });
    expect(released.state.interaction).toBeUndefined();
    expect(released.effects).toEqual([
      { type: "release-pointer", pointerId: 1 },
      { type: "select-element", elementId: "shape-a", mode: "replace" },
      { type: "open-context-menu", source: "pointer", position: { x: 10, y: 20 } },
    ]);
    expect(reduceInput(released.state, { type: "pointer-up", pointerId: 1 }).effects).toEqual([]);
  });

  it.each([
    {
      axis: "horizontal",
      first: { x: 17, y: 22 },
      second: { x: 20, y: 90 },
      effects: [
        { type: "pan-page", screenDeltaX: 7 },
        { type: "pan-page", screenDeltaX: 3 },
      ],
    },
    {
      axis: "vertical",
      first: { x: 12, y: 27 },
      second: { x: 90, y: 30 },
      effects: [
        { type: "pan-page", screenDeltaX: 0, screenDeltaY: 7 },
        { type: "pan-page", screenDeltaX: 0, screenDeltaY: 3 },
      ],
    },
  ] as const)(
    "locks $axis navigation without diagonal motion or editing",
    ({ axis, first, second, effects }) => {
      const started = reduceInput(createInputState({ hasSelection: true }), {
        ...secondary,
        target: { elementId: "selected-shape", isSelected: true },
      });
      const moved = reduceInput(started.state, pointerMove(first));
      const continued = reduceInput(moved.state, pointerMove(second));
      expect(moved.state.interaction).toMatchObject({ phase: "page-pan", axis });
      expect(continued.state.interaction).toMatchObject({ phase: "page-pan", axis });
      expect([...moved.effects, ...continued.effects]).toEqual(effects);
      const released = reduceInput(continued.state, { type: "pointer-up", pointerId: 1 });
      expect(released.state.hasSelection).toBe(true);
      expect(released.effects).toEqual([{ type: "release-pointer", pointerId: 1 }]);
    },
  );

  it("does not reopen a menu after a coalesced excursion returns to its start", () => {
    const started = reduceInput(createInputState(), secondary);
    const returned = reduceInput(started.state, pointerMove({ x: 10, y: 20, maximumMovement: 20 }));
    expect(returned.state.interaction?.phase).toBe("page-pan");
    const released = reduceInput(returned.state, { type: "pointer-up", pointerId: 1 });
    expect(effectTypes(released.effects)).toEqual(["release-pointer"]);
  });

  it.each(["pointer-cancel", "lost-pointer-capture", "reset"] as const)(
    "cleans up %s before a normal primary gesture",
    (type) => {
      const started = reduceInput(createInputState(), secondary);
      const moved = reduceInput(started.state, pointerMove({ x: 10, y: 30 }));
      const cancelled = reduceInput(moved.state, { type, pointerId: 1 });
      expect(cancelled.state.interaction).toBeUndefined();
      expect(cancelled.effects).toEqual([
        { type: "revert-navigation", kind: "page-pan" },
        { type: "release-pointer", pointerId: 1 },
      ]);
      expect(reduceInput(cancelled.state, pointerDown()).state.interaction?.phase).toBe(
        "tool-gesture",
      );
    },
  );

  it("keeps Control-click and pen barrel buttons outside secondary mouse arbitration", () => {
    const initial = createInputState();
    for (const down of [
      pointerDown({ controlOrMeta: true, isPlatformContextClick: true }),
      pointerDown({ pointerType: "pen", button: 2, buttons: 2 }),
      pointerDown({ button: 0, buttons: 3 }),
    ])
      expect(reduceInput(initial, down)).toEqual({ state: initial, effects: [] });
  });
});
