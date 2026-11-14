// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { rotatePointClockwise } from "../../../../../../src/domain/geometry/public";
import { textElement } from "../../../../../fixtures/rendering/text";
import { selectionHandleRefreshFixture } from "../../../../../fixtures/obsidian/selection-handle-refresh";
import {
  textHandleHoverFixture,
  textHandleNavigation,
} from "../../../../../fixtures/obsidian/text-handle-hover";
import { appendOwnedIframe } from "../../../../../fixtures/obsidian/owned-iframe";
import { immediateWorkScheduler } from "../../../../../fixtures/obsidian/immediate-work-scheduler";
import { TextHandleHover } from "../../../../../../src/obsidian/embeds/active-editor/text-handle-hover";

it.each([
  [0, "ew-resize"],
  [45, "nwse-resize"],
] as const)(
  "uses the native resize direction at %s degrees and restores source text hover",
  (rotation, cursor) => {
    const text = textElement({ rotation });
    const selection = selectionHandleRefreshFixture([text]);
    selection.interaction.renderSelection();
    const state = textHandleHoverFixture(selection.interaction);
    const right = rotatePointClockwise(
      { x: text.x + text.width, y: text.y + text.height / 2 },
      text.pivot,
      rotation,
    );
    state.move(right);
    expect(state.cursor()).toBe(cursor);
    state.move(text.pivot);
    expect(state.cursor()).toBe("");
    expect(state.child.documentElement.hasAttribute("data-inkbook-text-handle-cursor")).toBe(false);
    state.move(right);
    expect(state.cursor()).toBe(cursor);
    state.content.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    expect(state.cursor()).toBe("");
  },
);

it("uses the visible source height and retires child cursor ownership on deactivation and disposal", () => {
  const text = textElement();
  const selection = selectionHandleRefreshFixture([text]);
  selection.interaction.setTextEditingHeight(text.id, text.height + 200);
  const state = textHandleHoverFixture(selection.interaction);
  const bottom = { x: text.x + text.width, y: text.y + text.height + 200 };
  state.move(bottom);
  expect(state.cursor()).toBe("nwse-resize");
  state.deactivate();
  state.move(bottom);
  expect(state.cursor()).toBe("");
  state.hover.dispose();
  state.move(bottom);
  expect(state.cursor()).toBe("");
});

it("shares hover between nested input and drawing controls without double projection or retained listeners", () => {
  const outer = appendOwnedIframe(),
    inner = appendOwnedIframe(outer.document);
  const content = inner.document.createElement("div"),
    control = outer.document.createElement("button");
  inner.document.body.append(content);
  outer.document.body.append(control);
  const read = vi
    .spyOn(outer.frame, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(50, 70, 800, 600));
  const cursorAt = vi.fn(() => "ew-resize" as const);
  const coordinates = {
    drawingDocument: outer.document,
    toDrawingPoint: (point: { x: number; y: number }) => ({ x: point.x + 100, y: point.y + 200 }),
    fromDrawingPoint: () => undefined,
    toDrawingRect: () => undefined,
  };
  const hover = new TextHandleHover({
    document: outer.document,
    ownerWindow: window,
    scheduler: immediateWorkScheduler(),
    active: () => true,
    coordinates: () => coordinates,
    handles: { cursorAt },
    navigation: textHandleNavigation,
  });
  hover.setDocument(inner.document);
  const move = (target: HTMLElement, x: number, y: number) =>
    target.dispatchEvent(
      new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }),
    );
  move(content, 10, 20);
  move(control, 110, 220);
  expect(cursorAt).toHaveBeenCalledTimes(2);
  expect(cursorAt.mock.calls[0]).toEqual(cursorAt.mock.calls[1]);
  expect(cursorAt).toHaveBeenLastCalledWith(expect.objectContaining({ x: 160, y: 290 }), false);
  for (const document of [outer.document, inner.document])
    expect(document.documentElement.style.getPropertyValue("--inkbook-text-handle-cursor")).toBe(
      "ew-resize",
    );
  hover.setDocument(outer.document);
  move(content, 10, 20);
  expect(cursorAt).toHaveBeenCalledTimes(2);
  hover.dispose();
  move(control, 110, 220);
  expect(cursorAt).toHaveBeenCalledTimes(2);
  read.mockRestore();
  outer.frame.remove();
});
