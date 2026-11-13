// @vitest-environment happy-dom

import { EditorSelection, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextFieldEditor } from "../../../../../src/obsidian/text/editor/text-field-editor";
import { setTextPreview } from "../../../../../src/obsidian/text/editor/text-preview-decorations";
import {
  activate,
  disposeTableEditors,
  mount,
  parsedTable,
  TABLE_SOURCE,
} from "../../../../fixtures/obsidian/text-table-editor";
import { openTableMarkdownSource } from "../../../../fixtures/obsidian/text-table-source-action";

const content = `before\n\n${TABLE_SOURCE}`;
let pendingSelectionEvents = 0;

beforeEach(() => {
  const delivering = new WeakSet<Event>();
  const dispatch = document.dispatchEvent.bind(document);
  vi.spyOn(document, "dispatchEvent").mockImplementation((event) => {
    if (event.type !== "selectionchange" || delivering.has(event)) return dispatch(event);
    // Browsers queue selectionchange; happy-dom dispatches it inside Selection.collapse.
    // Deliver the real event after CodeMirror's synchronous DOM update has completed.
    pendingSelectionEvents += 1;
    queueMicrotask(() => {
      delivering.add(event);
      try {
        dispatch(event);
      } finally {
        delivering.delete(event);
        pendingSelectionEvents -= 1;
      }
    });
    return true;
  });
});

describe("native table caret after preview publication", () => {
  it("restores the latest caret when Chromium resets its range while preview marks change", async () => {
    const { editor, settle, onError } = await mount(content);
    const input = activate(editor, 1, 0);
    let resets = 0;
    let resetPreviewSelection = true;
    input.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (
            !resetPreviewSelection ||
            !update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(setTextPreview)),
            )
          )
            return;
          // Chromium can reset the native range as existing text moves into preview spans.
          const start = input.domAtPos(0);
          document.getSelection()!.collapse(start.node, start.offset);
          resets += 1;
        }),
      ),
      selection: { anchor: 0, head: 3 },
    });
    expect(editor.applyStyle("text-underline", true)).toBe(true);
    input.dispatch({ selection: { anchor: 3 } });
    await settle();
    await drainSelectionEvents();
    expect(resets).toBeGreaterThan(0);
    const selection = document.getSelection()!;
    expect(input.posAtDOM(selection.anchorNode!, selection.anchorOffset)).toBe(3);
    expect(input.posAtDOM(selection.focusNode!, selection.focusOffset)).toBe(3);
    expect(input.state.selection.main.head).toBe(3);
    resetPreviewSelection = false;
    input.dispatch(input.state.replaceSelection("!"));
    await settle();
    await drainSelectionEvents();
    expect(editor.source).toBe(content.replace("one", "one!"));
    expect(editor.view.contentDOM.querySelector("table")).not.toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});

async function drainSelectionEvents(): Promise<void> {
  for (let turn = 0; pendingSelectionEvents && turn < 32; turn += 1) await Promise.resolve();
  expect(pendingSelectionEvents).toBe(0);
}

function press(editor: TextFieldEditor, key: string, shiftKey = false): void {
  editor.inputView.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
  );
}

function expectSourceSelection(editor: TextFieldEditor, head: number): void {
  expect(editor.inputView === editor.view).toBe(true);
  expect(editor.view.state.selection.main.head).toBe(head);
  expect(editor.view.contentDOM.querySelector("table")).toBeNull();
  expect(editor.source).toBe(content);
}

async function moveThroughSource(
  editor: TextFieldEditor,
  settle: () => Promise<void>,
  position: number,
  shiftKey = false,
): Promise<void> {
  editor.view.dispatch({ selection: { anchor: position } });
  editor.view.focus();
  vi.spyOn(editor.view, "moveByChar").mockReturnValue(
    EditorSelection.cursor(position + (shiftKey ? 2 : 1)),
  );
  press(editor, "ArrowRight", shiftKey);
  await settle();
  await drainSelectionEvents();
}

afterEach(async () => {
  await drainSelectionEvents();
  disposeTableEditors();
  await drainSelectionEvents();
});

describe("rendered table arrow navigation", () => {
  it.each(["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"])(
    "enters the rendered table from surrounding text with %s",
    async (key) => {
      const { editor, settle, onError } = await mount(content);
      const { block, table } = parsedTable(editor);
      const forward = key === "ArrowRight" || key === "ArrowDown";
      const position = forward
        ? editor.view.state.doc.lineAt(table.rows[0]!.start).from - 1
        : editor.view.state.doc.lineAt(table.rows[table.rows.length - 1]!.end).to + 1;
      editor.view.dispatch({ selection: { anchor: position } });
      editor.view.focus();
      // happy-dom has no text layout; retain real key handling and table activation.
      vi.spyOn(editor.view, "moveByChar").mockReturnValue(
        EditorSelection.cursor(forward ? block.end : block.start),
      );
      vi.spyOn(editor.view, "moveVertically").mockReturnValue(
        EditorSelection.cursor(forward ? block.end : block.start),
      );
      press(editor, key);
      await settle();
      await drainSelectionEvents();
      expect(editor.inputView === editor.view).toBe(false);
      expect(editor.inputView.state.doc.toString()).toBe(forward ? "Name" : "$x$");
      expect(editor.inputView.state.selection.main.head).toBe(forward ? 0 : 3);
      expect(editor.inputView.hasFocus).toBe(true);
      expect(editor.view.contentDOM.querySelector("table")).not.toBeNull();
      expect(editor.source).toBe(content);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it.each(["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"])(
    "leaves the first or last cell with %s without appending a row",
    async (key) => {
      const { editor, settle, onError } = await mount(content);
      const { table } = parsedTable(editor);
      const forward = key === "ArrowRight" || key === "ArrowDown";
      const destination = forward
        ? editor.view.state.doc.lineAt(table.rows[table.rows.length - 1]!.end).to + 1
        : editor.view.state.doc.lineAt(table.rows[0]!.start).from - 1;
      const input = activate(editor, forward ? 1 : 0, forward ? 1 : 0);
      input.dispatch({ selection: { anchor: forward ? input.state.doc.length : 0 } });
      press(editor, key);
      await settle();
      await drainSelectionEvents();
      expect(editor.inputView === editor.view).toBe(true);
      expect(editor.view.hasFocus).toBe(true);
      expect(editor.selectionEnd).toBe(destination);
      expect(parsedTable(editor).table.rows).toHaveLength(2);
      expect(editor.view.contentDOM.querySelector("table")).not.toBeNull();
      expect(editor.source).toBe(content);
      expect(onError).not.toHaveBeenCalled();
    },
  );
});

describe("table arrow destinations and source ownership", () => {
  it("enters the previous cell at its end and the next cell at its start before typing", async () => {
    const { editor, settle, onError } = await mount(content);
    activate(editor, 1, 1);
    press(editor, "ArrowLeft");
    expect(editor.inputView.state.doc.toString()).toBe("one");
    expect(editor.inputView.state.selection.main.head).toBe(3);
    editor.inputView.dispatch(editor.inputView.state.replaceSelection("!"));
    press(editor, "ArrowRight");
    expect(editor.inputView.state.doc.toString()).toBe("$x$");
    expect(editor.inputView.state.selection.main.head).toBe(0);
    editor.inputView.dispatch(editor.inputView.state.replaceSelection("next "));
    await settle();
    await drainSelectionEvents();
    expect(editor.source).toBe(content.replace("one", "one!").replace("$x$", "next $x$"));
    expect(editor.view.contentDOM.querySelector("table")).not.toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("extends a source selection with Shift+ArrowRight instead of entering a cell", async () => {
    const { editor, settle, onError } = await mount(content);
    const { block } = parsedTable(editor);
    await moveThroughSource(editor, settle, block.start - 1, true);
    expect(editor.view.state.selection.main.anchor).toBe(block.start - 1);
    expectSourceSelection(editor, block.start + 1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps arrow navigation in explicitly opened Markdown source", async () => {
    const { editor, settle, onError } = await mount(content, true);
    openTableMarkdownSource(editor);
    await settle();
    const { block } = parsedTable(editor);
    await moveThroughSource(editor, settle, block.start);
    expectSourceSelection(editor, block.start + 1);
    expect(onError).not.toHaveBeenCalled();
  });
});
