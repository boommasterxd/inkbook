import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type Editor, type MarkdownFileInfo } from "obsidian";
import { vi } from "vitest";

import { createHtmlElement } from "../../adapters/obsidian/dom";

import { createPenTapInsertionExtension } from "../../../src/obsidian/commands/pen-tap-extension";
import { PenTapInsertionController } from "../../../src/obsidian/commands/pen-tap-insertion";

export function mountPenTapEditor(text = "Text\n") {
  const ports = {
    setCursor: vi.fn(),
    command: vi.fn(() => true),
    enabled: vi.fn(() => true),
    canInsertAtLine: vi.fn((_editor: Editor, _path: string, line: number) => {
      return text.split("\n")[line] === "";
    }),
  };
  const fixture = mountWithPorts(text, ports);
  const posAtCoords = vi.spyOn(fixture.view, "posAtCoords").mockReturnValue(text.length);
  return { ...fixture, ...ports, posAtCoords };
}

export function mountCountedPenTapEditor(text = "Text\n") {
  const counts = { setCursor: 0, command: 0, canInsertAtLine: 0, posAtCoords: 0 };
  const fixture = mountWithPorts(text, {
    setCursor: () => {
      counts.setCursor += 1;
    },
    command: () => {
      counts.command += 1;
      return true;
    },
    enabled: () => true,
    canInsertAtLine: (_editor: Editor, _path: string, line: number) => {
      counts.canInsertAtLine += 1;
      return text.split("\n")[line] === "";
    },
  });
  const posAtCoords = () => {
    counts.posAtCoords += 1;
    return text.length;
  };
  fixture.view.posAtCoords = posAtCoords;
  return { ...fixture, counts, posAtCoords };
}

interface PenTapPorts {
  readonly setCursor: () => void;
  readonly command: () => boolean;
  readonly enabled: () => boolean;
  readonly canInsertAtLine: (editor: Editor, path: string, line: number) => boolean;
}

function mountWithPorts<Ports extends PenTapPorts>(text: string, ports: Ports) {
  const editor = { setCursor: ports.setCursor } as unknown as Editor;
  const context = { editor, file: { path: "note.md" } } as MarkdownFileInfo;
  const controller = new PenTapInsertionController(ports, ports.enabled, {
    id: "insert-handwriting-embed",
    name: "Insert handwriting embed",
    editorCheckCallback: ports.command,
  });
  const parent = createHtmlElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [editorInfoField.init(() => context), createPenTapInsertionExtension(controller)],
    }),
  });
  const originalPosition = Object.getOwnPropertyDescriptor(view, "posAtCoords");
  const originalBounds = Object.getOwnPropertyDescriptor(view.scrollDOM, "getBoundingClientRect");
  const bounds = new DOMRect(0, 0, 800, 600);
  view.scrollDOM.getBoundingClientRect = () => bounds;
  Object.defineProperties(view.scrollDOM, {
    clientWidth: { configurable: true, value: 780 },
    clientLeft: { configurable: true, value: 0 },
    clientHeight: { configurable: true, value: 580 },
    clientTop: { configurable: true, value: 0 },
  });
  return {
    ...ports,
    controller,
    parent,
    view,
    destroy: () => {
      view.destroy();
      restoreMethod(view, "posAtCoords", originalPosition);
      restoreMethod(view.scrollDOM, "getBoundingClientRect", originalBounds);
      parent.remove();
    },
  };
}

function restoreMethod(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor === undefined) Reflect.deleteProperty(target, key);
  else Object.defineProperty(target, key, descriptor);
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
