import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type Editor, type MarkdownFileInfo, type Menu } from "obsidian";

import { addInsertionContextMenuItem, type InkbookInsertionCommand } from "./command-registry";
import type { EmptyLineInsertionController } from "./empty-line-insertion";
import { eventPathHasClass } from "./event-path";

interface MenuTarget {
  readonly editor: Editor;
  readonly line: number | null;
}

export class InsertionContextMenuController {
  readonly #command: InkbookInsertionCommand;
  readonly #canInsert: EmptyLineInsertionController["canInsertAtLine"];
  #target: MenuTarget | undefined;
  #expiry: { readonly ownerWindow: Window; readonly handle: number } | undefined;

  constructor(
    command: InkbookInsertionCommand,
    canInsert: EmptyLineInsertionController["canInsertAtLine"],
  ) {
    this.#command = command;
    this.#canInsert = canInsert;
  }

  capture(editor: Editor, line: number | null, ownerWindow: Window): void {
    this.clear();
    this.#target = { editor, line };
    // Obsidian may populate the menu in a later listener, after a microtask checkpoint.
    this.#expiry = {
      ownerWindow,
      handle: ownerWindow.setTimeout(() => this.clear(), 0),
    };
  }

  clear(): void {
    if (this.#expiry !== undefined) {
      this.#expiry.ownerWindow.clearTimeout(this.#expiry.handle);
      this.#expiry = undefined;
    }
    this.#target = undefined;
  }

  addItem(menu: Menu, editor: Editor, context: MarkdownFileInfo): void {
    const target = this.#target;
    this.clear();
    const line = target?.editor === editor ? target.line : editor.getCursor().line;
    const sourcePath = context.file?.path;
    if (line === null || sourcePath === undefined || !this.#canInsert(editor, sourcePath, line))
      return;
    addInsertionContextMenuItem(this.#command, menu, editor, context, line);
  }
}

export function createInsertionContextMenuExtension(
  controller: InsertionContextMenuController,
): Extension {
  return EditorView.domEventObservers({
    contextmenu: (event, view) => {
      const editor = view.state.field(editorInfoField, false)?.editor;
      if (editor === undefined) return;
      if (event.button === 0 && !("pointerType" in event && event.pointerType === "touch")) {
        controller.clear();
        return;
      }
      const ownerWindow = view.dom.ownerDocument.defaultView;
      if (ownerWindow === null) return;
      const position = eventPathHasClass(event, "inkbook-root")
        ? null
        : view.posAtCoords({ x: event.clientX, y: event.clientY });
      controller.capture(
        editor,
        position === null ? null : view.state.doc.lineAt(position).number - 1,
        ownerWindow,
      );
    },
  });
}
