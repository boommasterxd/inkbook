import { EditorState } from "@codemirror/state";
import { EditorView, type DOMEventHandlers } from "@codemirror/view";
import { editorInfoField, type Editor, type MarkdownFileInfo, type Menu } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  createInsertionContextMenuExtension,
  InsertionContextMenuController,
} from "../../../../src/obsidian/commands";
import { registerInsertion } from "./insertion-command-fixture";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

function createHarness() {
  let expire: FrameRequestCallback | undefined;
  const ownerWindow = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      expire = callback;
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
  } as unknown as Window;
  let line = 0;
  const setCursor = vi.fn((position: { line: number }) => {
    line = position.line;
  });
  const editor = { getCursor: () => ({ line, ch: 0 }), setCursor } as unknown as Editor;
  const context = { editor, file: { path: "note.md" } } as MarkdownFileInfo;
  const request = vi.fn(() => true);
  const command = registerInsertion({ canInsert: () => line === 0, request });
  const canInsert = vi.fn((_editor: Editor, _path: string, target: number) => target === 0);
  const controller = new InsertionContextMenuController(command, canInsert, () =>
    workSchedulerFromFrames(ownerWindow),
  );
  const addItem = vi.fn();
  const menu = { addItem } as unknown as Menu;
  return {
    addItem,
    canInsert,
    command,
    context,
    controller,
    editor,
    menu,
    request,
    setCursor,
    ownerWindow,
    expire: () => expire?.(0),
  };
}

describe("native insertion context targets", () => {
  it("uses the clicked line even when the cursor remains on another empty line", () => {
    const { addItem, canInsert, context, controller, editor, menu, ownerWindow, setCursor } =
      createHarness();
    controller.capture(editor, 1, ownerWindow);
    controller.addItem(menu, editor, context);
    expect(canInsert).toHaveBeenCalledWith(editor, "note.md", 1);
    expect(addItem).not.toHaveBeenCalled();
    expect(setCursor).not.toHaveBeenCalled();
  });

  it("offers insertion on a clicked empty line without changing a text cursor or selection", () => {
    const { addItem, context, controller, editor, menu, ownerWindow, setCursor } = createHarness();
    setCursor({ line: 1 });
    setCursor.mockClear();
    controller.capture(editor, 0, ownerWindow);
    controller.addItem(menu, editor, context);
    expect(addItem).toHaveBeenCalledOnce();
    expect(setCursor).not.toHaveBeenCalled();
  });

  it("consumes a pointer target and expires unconsumed targets before later keyboard menus", async () => {
    const { addItem, context, controller, editor, menu, ownerWindow, expire } = createHarness();
    controller.capture(editor, 1, ownerWindow);
    controller.addItem(menu, editor, context);
    controller.addItem(menu, editor, context);
    expect(addItem).toHaveBeenCalledOnce();
    controller.capture(editor, 1, ownerWindow);
    await Promise.resolve();
    controller.addItem(menu, editor, context);
    expect(addItem).toHaveBeenCalledOnce();
    controller.capture(editor, 1, ownerWindow);
    expire();
    controller.addItem(menu, editor, context);
    expect(addItem).toHaveBeenCalledTimes(2);
  });

  it("rejects unmappable or widget targets and does not reuse another editor's target", () => {
    const { addItem, context, controller, editor, menu, ownerWindow } = createHarness();
    controller.capture(editor, null, ownerWindow);
    controller.addItem(menu, editor, context);
    expect(addItem).not.toHaveBeenCalled();
    controller.capture({} as Editor, 1, ownerWindow);
    controller.addItem(menu, editor, context);
    expect(addItem).toHaveBeenCalledOnce();
  });

  it("resolves pointer context menus with public CodeMirror coordinates before native handlers", () => {
    const { controller, editor, context, ownerWindow } = createHarness();
    let observers: DOMEventHandlers<unknown> | undefined;
    const spy = vi.spyOn(EditorView, "domEventObservers").mockImplementation((registered) => {
      observers = registered;
      return [];
    });
    createInsertionContextMenuExtension(controller);
    spy.mockRestore();
    const state = EditorState.create({
      doc: "\ntext",
      extensions: [editorInfoField.init(() => context)],
    });
    const view = {
      state,
      dom: { ownerDocument: { defaultView: ownerWindow } },
      posAtCoords: vi.fn(() => 1),
    } as unknown as EditorView;
    const capture = vi.spyOn(controller, "capture");
    const event = {
      button: 2,
      clientX: 20,
      clientY: 40,
      composedPath: () => [],
    } as unknown as PointerEvent;
    observers?.contextmenu?.call({}, event, view);
    expect(capture).toHaveBeenCalledWith(editor, 1, ownerWindow);
    capture.mockClear();
    observers?.contextmenu?.call({}, { ...event, button: 0 }, view);
    expect(capture).not.toHaveBeenCalled();
    observers?.contextmenu?.call({}, { ...event, button: 0, pointerType: "touch" }, view);
    expect(capture).toHaveBeenCalledWith(editor, 1, ownerWindow);
    observers?.contextmenu?.call(
      {},
      {
        ...event,
        composedPath: () => [{ classList: { contains: () => true } } as unknown as EventTarget],
      },
      view,
    );
    expect(capture).toHaveBeenLastCalledWith(editor, null, ownerWindow);
    capture.mockClear();
    observers?.contextmenu?.call({}, event, { state: EditorState.create() } as EditorView);
    expect(capture).not.toHaveBeenCalled();
  });
});
