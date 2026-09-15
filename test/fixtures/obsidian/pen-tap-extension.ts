import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type Editor, type MarkdownFileInfo } from "obsidian";
import { vi } from "vitest";

import { createHtmlElement } from "../../adapters/obsidian/dom";

import { createPenTapInsertionExtension } from "../../../src/obsidian/commands/pen-tap-extension";
import { PenTapInsertionController } from "../../../src/obsidian/commands/pen-tap-insertion";

export function mountPenTapEditor(
  text = "Text\n",
  implementation = { createPenTapInsertionExtension, PenTapInsertionController },
) {
  const { createPenTapInsertionExtension: createExtension, PenTapInsertionController: Controller } =
    implementation;
  const setCursor = vi.fn();
  const editor = { setCursor } as unknown as Editor;
  const context = { editor, file: { path: "note.md" } } as MarkdownFileInfo;
  const command = vi.fn(() => true);
  const enabled = vi.fn(() => true);
  const canInsertAtLine = vi.fn((_editor: Editor, _path: string, line: number) => {
    return text.split("\n")[line] === "";
  });
  const controller = new Controller({ canInsertAtLine }, enabled, {
    id: "insert-handwriting-embed",
    name: "Insert handwriting embed",
    editorCheckCallback: command,
  });
  const parent = createHtmlElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [editorInfoField.init(() => context), createExtension(controller)],
    }),
  });
  const posAtCoords = vi.spyOn(view, "posAtCoords").mockReturnValue(text.length);
  vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
  Object.defineProperties(view.scrollDOM, {
    clientWidth: { configurable: true, value: 780 },
    clientLeft: { configurable: true, value: 0 },
    clientHeight: { configurable: true, value: 580 },
    clientTop: { configurable: true, value: 0 },
  });
  return {
    canInsertAtLine,
    command,
    controller,
    enabled,
    parent,
    posAtCoords,
    setCursor,
    view,
    destroy: () => {
      view.destroy();
      parent.remove();
    },
  };
}

export function penEvent(type: string, overrides: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerdown" ? 1 : 0,
    clientX: 700,
    clientY: 400,
    pointerId: 7,
    pointerType: "pen",
    ...overrides,
  });
}

export function penTapSurface(editor: ReturnType<typeof mountPenTapEditor>, surface: string) {
  const widget = createHtmlElement("div");
  widget.className = "inkbook-root";
  editor.view.contentDOM.append(widget);
  return {
    target: surface === "widget" ? widget : editor.view.scrollDOM,
    pointerType: surface === "touch" ? "touch" : "pen",
  };
}
