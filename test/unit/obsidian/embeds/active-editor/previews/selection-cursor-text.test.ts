import { expect, it } from "vitest";
import {
  calculateElementBounds,
  rotatePointClockwise,
} from "../../../../../../src/domain/geometry/public";
import {
  HitTestScratch,
  selectionOverlayGeometry,
} from "../../../../../../src/editor/selection/public";
import {
  selectionCursorAt,
  selectionCursorHandle,
} from "../../../../../../src/obsidian/embeds/active-editor/previews/selection-cursor";
import { textElement } from "../../../../../fixtures/rendering/text";

const zoom = 0.145465;

function selectedText(rotation = 0, padding = 24) {
  const text = textElement({
    x: 120,
    y: 100,
    width: 400,
    height: 422.344,
    pivot: { x: 320, y: 311.172 },
    rotation,
  });
  text.layout.padding = padding;
  const selected = [{ element: text, bounds: calculateElementBounds(text) }];
  const geometry = selectionOverlayGeometry(selected, zoom)!;
  const pointer = (x: number, y: number) => ({
    ...rotatePointClockwise({ x, y }, text.pivot, rotation),
    pointerId: 1,
    pointerType: "touch" as const,
  });
  return { text, selected, geometry, pointer };
}

it.each([0, 30])(
  "keeps low-zoom body text outside invisible grip targets at %s degrees",
  (rotation) => {
    const state = selectedText(rotation);
    const body = state.pointer(258, 155);
    expect(selectionCursorHandle(state.geometry, body, zoom)).toMatchObject({
      position: "top-left",
    });
    expect(selectionCursorHandle(state.geometry, body, zoom, state.selected)).toBeNull();
    expect(
      selectionCursorAt(state.geometry, body, {
        zoom,
        rotation,
        linear: undefined,
        hit: new HitTestScratch(),
        selected: state.selected,
      }),
    ).toBe("move");
  },
);

it("retains the visible inner grip half inside unpadded rotated text content", () => {
  const state = selectedText(30, 0);
  const inside = state.pointer(state.text.x + 3 / zoom, state.text.y + 3 / zoom);
  expect(selectionCursorHandle(state.geometry, inside, zoom, state.selected)).toMatchObject({
    kind: "scale",
    position: "top-left",
  });
  const beyond = state.pointer(state.text.x + 5 / zoom, state.text.y + 5 / zoom);
  expect(selectionCursorHandle(state.geometry, beyond, zoom, state.selected)).toBeNull();
});

it("keeps enlarged targets outside content but limits owned revealed editor content to visible grips", () => {
  const state = selectedText();
  const outside = state.pointer(state.text.x - 100, state.text.y);
  expect(selectionCursorHandle(state.geometry, outside, zoom, state.selected)).toMatchObject({
    position: "top-left",
  });
  expect(selectionCursorHandle(state.geometry, outside, zoom, state.selected, true)).toBeNull();
});
