// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";
import { resolveShapeAnchor } from "../../../../../src/domain/geometry/anchors";
import { rotatePointClockwise } from "../../../../../src/domain/geometry/primitives";
import {
  navigateActiveTextHistory,
  useActiveTextSessions,
} from "../../../../fixtures/obsidian/active-text-session";
import { line, textElement } from "../../../../unit/domain/schema/fixtures";

const mount = useActiveTextSessions();

function stored(state: ReturnType<typeof mount>) {
  return state.model.store.get(state.element.id)!.element as TextElementV2;
}

function glyphOrigin(element: TextElementV2) {
  const first = element.layout.lines[0]!;
  return rotatePointClockwise(
    {
      x: element.x + first.x + first.runs[0]!.x,
      y: element.y + first.y + first.baseline,
    },
    element.pivot,
    element.rotation,
  );
}

it("upgrades earlier explicit insets during normal editing without shifting visible text", async () => {
  const element = textElement();
  element.layout.padding = 8;
  const state = mount(element, true);
  await expect(state.session.edit(element.id)).resolves.toBe(true);
  const padded = stored(state);
  expect(padded.layout.padding).toBe(28);
  expect(glyphOrigin(padded)).toEqual(glyphOrigin(element));
  expect(padded.width - 56).toBe(element.width - 16);
  expect(state.history.commandCount).toBe(1);
  expect(state.prepare).not.toHaveBeenCalled();
});

it("upgrades a legacy field once without moving glyphs or changing wrapping, and keeps the upgrade on Escape", async () => {
  const element = { ...textElement(), rotation: 30 };
  const state = mount(element, true);
  await expect(state.session.edit(element.id, 3)).resolves.toBe(true);
  const padded = stored(state);
  const padding = padded.layout.padding!;
  expect(padding).toBeGreaterThan(0);
  expect(padded.width - padding * 2).toBe(element.width);
  expect(padded.height - padding * 2).toBe(element.height);
  expect(glyphOrigin(padded)).toEqual(glyphOrigin(element));
  expect(padded.layout.lines[0]!.runs).toEqual(element.layout.lines[0]!.runs);
  expect(padded).toMatchObject({ source: element.source, pivot: element.pivot, rotation: 30 });
  expect(state.history.commandCount).toBe(1);
  expect(state.input().state.selection.main.head).toBe(3);
  state.input().contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await vi.waitFor(() => expect(state.session.active).toBe(false));
  await expect(state.session.edit(element.id, { x: 110, y: 115 })).resolves.toBe(true);
  expect(stored(state)).toEqual(padded);
  expect(state.history.commandCount).toBe(1);
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.error).not.toHaveBeenCalled();
});

it("reenters native undo and redo with the saved layout and caret instead of creating an upgrade loop", async () => {
  const state = mount(textElement(), true);
  await state.session.edit(state.element.id, 3);
  const padded = stored(state);
  await navigateActiveTextHistory(state);
  expect(stored(state)).toEqual(state.element);
  expect(stored(state).layout.padding).toBeUndefined();
  expect(state.input().state.selection.main.head).toBe(3);
  expect(state.history.canRedo).toBe(true);
  expect(state.history.commandCount).toBe(1);
  await navigateActiveTextHistory(state, true);
  expect(stored(state)).toEqual(padded);
  expect(state.history.canRedo).toBe(false);
  expect(state.history.commandCount).toBe(1);
  expect(state.error).not.toHaveBeenCalled();
});

it("flushes pending source for export and replays connected field geometry through prepared history", async () => {
  const state = mount(textElement(), true);
  const connection = {
    ...line(),
    start: resolveShapeAnchor(state.element, { kind: "box", position: "bottom-right" })!,
    startConnection: {
      targetId: state.element.id,
      anchor: { kind: "box", position: "bottom-right" } as const,
    },
  };
  state.model.store.create(connection);
  const preparation = vi.spyOn(state.model, "prepareElementReplacement");
  await state.session.edit(state.element.id);
  const padded = stored(state);
  expect(state.model.store.get(connection.id)?.element).toMatchObject({
    start: resolveShapeAnchor(padded, { kind: "box", position: "bottom-right" }),
  });
  state.input().dispatch({ changes: { from: 5, insert: " pending" } });
  await state.prepareExport();
  expect(state.session.active).toBe(false);
  expect(stored(state).source).toBe("Hello pending");
  expect(stored(state).layout.padding).toBe(padded.layout.padding);
  expect(preparation).toHaveBeenCalledTimes(2);
  expect(state.history.commandCount).toBe(2);
  await expect(state.history.undoAsync()).resolves.toBe(true);
  expect(stored(state)).toEqual(padded);
  await expect(state.history.undoAsync()).resolves.toBe(true);
  expect(stored(state)).toEqual(state.element);
  expect(state.model.store.get(connection.id)?.element).toEqual(connection);
  expect(state.operations()).toBe(0);
  expect(state.error).not.toHaveBeenCalled();
});

it("cancels a pending upgrade on disposal before any geometry or history is committed", async () => {
  const state = mount(textElement(), true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepare = state.model.prepareElementReplacement.bind(state.model);
  const preparation = vi
    .spyOn(state.model, "prepareElementReplacement")
    .mockImplementationOnce(async (...args) => {
      await gate;
      return prepare(...args);
    });
  const opening = state.session.edit(state.element.id);
  await vi.waitFor(() => expect(preparation).toHaveBeenCalledOnce());
  state.session.dispose();
  release();
  await expect(opening).resolves.toBe(false);
  expect(stored(state)).toEqual(state.element);
  expect(state.history.commandCount).toBe(0);
  expect(state.renderer.beginTextEditing).not.toHaveBeenCalled();
  expect(state.operations()).toBe(0);
  expect(state.error).not.toHaveBeenCalled();
});
