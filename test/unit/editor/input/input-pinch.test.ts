import { describe, expect, it } from "vitest";
import { createInputState, reduceInput } from "../../../../src/editor/input/index";
import { pointerDown, pointerMove } from "../../../fixtures/editor/input-actions";

function begin(firstX = 10, secondX = 30) {
  const first = reduceInput(
    createInputState(),
    pointerDown({ pointerType: "touch", x: firstX, y: 20 }),
  ).state;
  return reduceInput(first, pointerDown({ pointerType: "touch", pointerId: 2, x: secondX, y: 20 }))
    .state;
}

describe("absolute pinch distance", () => {
  it("reports scale against gesture origin across reversal and translation", () => {
    const enlarged = reduceInput(
      begin(),
      pointerMove({ pointerId: 2, pointerType: "touch", x: 90, y: 20 }),
    );
    expect(enlarged.effects).toEqual([
      { type: "update-pinch", anchor: { x: 50, y: 20 }, factor: 4 },
    ]);
    const reversed = reduceInput(
      enlarged.state,
      pointerMove({ pointerId: 2, pointerType: "touch", x: 82, y: 20 }),
    );
    expect(reversed.effects).toEqual([
      { type: "update-pinch", anchor: { x: 46, y: 20 }, factor: 3.6 },
    ]);
    const translatedFirst = reduceInput(
      reversed.state,
      pointerMove({ pointerId: 1, pointerType: "touch", x: 30, y: 20 }),
    );
    const translated = reduceInput(
      translatedFirst.state,
      pointerMove({ pointerId: 2, pointerType: "touch", x: 102, y: 20 }),
    );
    expect(translated.effects).toEqual([
      { type: "update-pinch", anchor: { x: 66, y: 20 }, factor: 3.6 },
    ]);
  });

  it("rebases coincident initial contacts once a positive distance becomes available", () => {
    const separated = reduceInput(
      begin(10, 10),
      pointerMove({ pointerId: 2, pointerType: "touch", x: 30, y: 20 }),
    );
    expect(separated.effects).toEqual([
      { type: "update-pinch", anchor: { x: 20, y: 20 }, factor: 1 },
    ]);
    const enlarged = reduceInput(
      separated.state,
      pointerMove({ pointerId: 2, pointerType: "touch", x: 50, y: 20 }),
    );
    expect(enlarged.effects).toEqual([
      { type: "update-pinch", anchor: { x: 30, y: 20 }, factor: 2 },
    ]);
    const collapsed = reduceInput(
      enlarged.state,
      pointerMove({ pointerId: 2, pointerType: "touch", x: 10, y: 20 }),
    );
    expect(collapsed.effects).toEqual([
      { type: "update-pinch", anchor: { x: 10, y: 20 }, factor: 0 },
    ]);
  });
});
