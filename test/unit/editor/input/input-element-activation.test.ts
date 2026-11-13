import { expect, it } from "vitest";
import { createInputState, reduceInput } from "../../../../src/editor/input";
import type { PointerDownAction } from "../../../../src/editor/input/input-types";
import { pointerDown, pointerMove } from "../../../fixtures/editor/input-actions";

function selectedPress(overrides: Partial<PointerDownAction> = {}) {
  return reduceInput(
    createInputState({ activeTool: "select", hasSelection: true }),
    pointerDown({
      target: { elementId: "selected", isSelected: true },
      timestamp: 100,
      ...overrides,
    }),
  ).state;
}

const release = { type: "pointer-up", pointerId: 1, timestamp: 200 } as const;

it.each(["mouse", "pen", "touch"] as const)(
  "activates the existing selected element after releasing an unmoved %s press",
  (pointerType) => {
    const result = reduceInput(selectedPress({ pointerType }), release);
    expect(result.effects).toEqual([
      ...(pointerType === "mouse" ? [] : [{ type: "cancel-long-press", pointerId: 1 }]),
      { type: "release-pointer", pointerId: 1 },
      { type: "activate-element", elementId: "selected" },
    ]);
    expect(result.state.interaction).toBeUndefined();
    expect(result.state.hasSelection).toBe(true);
  },
);

it.each([
  { controlOrMeta: true },
  { shift: true },
  { alt: true },
  { pointerType: "pen", penRole: "side-button" },
  { pointerType: "pen", penRole: "eraser" },
] satisfies Partial<PointerDownAction>[])(
  "keeps the modified press %j out of activation",
  (modifier) => {
    expect(reduceInput(selectedPress(modifier), release).effects).not.toContainEqual({
      type: "activate-element",
      elementId: "selected",
    });
  },
);

it("keeps the eraser tool's selected interaction out of activation", () => {
  const down = reduceInput(
    createInputState({ activeTool: "eraser", hasSelection: true }),
    pointerDown({ target: { elementId: "selected", isSelected: true } }),
  );
  expect(reduceInput(down.state, release).effects.map(({ type }) => type)).not.toContain(
    "activate-element",
  );
});

it.each([349, 350])("uses the existing touch tap duration at %sms", (duration) => {
  const result = reduceInput(selectedPress({ pointerType: "touch" }), {
    ...release,
    timestamp: 100 + duration,
  });
  expect(result.effects.some(({ type }) => type === "activate-element")).toBe(duration < 350);
});

it("does not activate a drag that returns to its original position", () => {
  const moved = reduceInput(selectedPress(), pointerMove({ x: 20, y: 20 }));
  const returned = reduceInput(moved.state, pointerMove({ x: 10, y: 20 }));
  expect(reduceInput(returned.state, release).effects).toEqual([
    { type: "commit-preview", kind: "element-move" },
    { type: "release-pointer", pointerId: 1 },
  ]);
});

it.each(["pointer-cancel", "lost-pointer-capture", "reset"] as const)(
  "does not activate a selected press after %s",
  (type) => {
    const cancelled = reduceInput(selectedPress({ pointerType: "touch" }), { type, pointerId: 1 });
    expect(cancelled.effects.map(({ type }) => type)).not.toContain("activate-element");
    expect(reduceInput(cancelled.state, release).effects).toEqual([]);
  },
);

it("does not activate after a selected touch begins a pinch or long press", () => {
  const touch = selectedPress({ pointerType: "touch" });
  const pinch = reduceInput(touch, pointerDown({ pointerType: "touch", pointerId: 2 }));
  expect(reduceInput(pinch.state, release).effects.map(({ type }) => type)).not.toContain(
    "activate-element",
  );
  const held = reduceInput(touch, { type: "long-press", pointerId: 1 });
  expect(held.effects.map(({ type }) => type)).toContain("open-context-menu");
  expect(reduceInput(held.state, release).effects.map(({ type }) => type)).not.toContain(
    "activate-element",
  );
});
