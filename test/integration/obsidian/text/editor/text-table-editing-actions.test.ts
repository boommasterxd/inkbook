// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { type TextFieldEditor } from "../../../../../src/obsidian/text/editor/text-field-editor";
import {
  TABLE_SOURCE as source,
  mount,
  parsedTable,
  activate,
  clickAction,
  disposeTableEditors,
} from "../../../../fixtures/obsidian/text-table-editor";

function press(editor: TextFieldEditor, key: string, modifiers: KeyboardEventInit = {}): void {
  editor.inputView.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }),
  );
}

function choose(editor: TextFieldEditor, label: string): void {
  clickAction(editor, "Table options");
  const item = [
    ...editor.view.dom.ownerDocument.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!item) throw new Error(`Expected table menu action: ${label}`);
  item.click();
}

function insertText(target: HTMLElement, text = "Replacement"): InputEvent {
  const event = new InputEvent("beforeinput", {
    inputType: "insertText",
    data: text,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function replaceOuterSelection(editor: TextFieldEditor, anchor: number, head: number): void {
  editor.view.dispatch({ selection: { anchor, head } });
  const event = insertText(editor.view.contentDOM);
  expect(event.defaultPrevented).toBe(false);
  editor.view.dispatch(editor.view.state.replaceSelection("Replacement"));
}

afterEach(disposeTableEditors);

describe("table cell keyboard navigation", () => {
  it("writes into each destination immediately after Tab and preserves the previous cell on reverse Tab", async () => {
    const { editor, settle, renderTable, onError } = await mount();
    activate(editor, 1, 0);
    const first = " FRESH42 ";
    editor.inputView.dispatch({ changes: { from: 0, to: 3, insert: first } });
    press(editor, "Tab");
    expect(editor.inputView.state.doc.toString()).toBe("$x$");
    const formula = "$\\sqrt{42}$";
    press(editor, "a", { ctrlKey: true });
    editor.inputView.dispatch(editor.inputView.state.replaceSelection(formula));
    press(editor, "Tab", { shiftKey: true });
    expect(editor.inputView.state.doc.toString()).toBe(first);
    press(editor, "End", { ctrlKey: true, code: "End", keyCode: 35 });
    const caret = editor.source.indexOf("FRESH42") + "FRESH42 ".length;
    expect(editor.inputView.state.selection.main.head).toBe(first.length);
    expect(editor.selectionEnd).toBe(caret);
    expect(insertText(editor.inputView.contentDOM, "!").defaultPrevented).toBe(false);
    expect(editor.inputView.state.selection.main.head).toBe(first.length);
    expect(editor.selectionEnd).toBe(caret);
    editor.inputView.dispatch(editor.inputView.state.replaceSelection("!"));
    press(editor, "Tab");
    expect(editor.inputView.state.doc.toString()).toBe(formula);
    expect(renderTable).toHaveBeenCalledOnce();
    await settle();
    expect(editor.source).toBe(source.replace("one", first + "!").replace("$x$", formula));
    expect(onError).not.toHaveBeenCalled();
  });

  it("moves with Tab and Shift+Tab while keeping the surrounding table rendered", async () => {
    const { editor, onError } = await mount();
    const widget = editor.view.contentDOM.querySelector(".inkbook-text-table-widget");
    activate(editor, 1, 0);
    expect(editor.inputView.state.doc.toString()).toBe("one");
    press(editor, "Tab");
    expect(editor.inputView.state.doc.toString()).toBe("$x$");
    press(editor, "Tab", { shiftKey: true });
    expect(editor.inputView.state.doc.toString()).toBe("one");
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBe(widget);
    expect(editor.source).toBe(source);
    expect(onError).not.toHaveBeenCalled();
  });

  it("appends a valid row and focuses its first cell after Tab in the last cell", async () => {
    const { editor, settle, onError } = await mount();
    activate(editor, 1, 1);
    press(editor, "Tab");
    await settle();
    const { table } = parsedTable(editor);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[2]!.cells).toHaveLength(2);
    expect(editor.selectionStart).toBe(table.rows[2]!.cells[0]!.contentStart);
    expect(editor.inputView).not.toBe(editor.view);
    expect(editor.inputView.state.doc.toString()).toBe("");
    expect(editor.inputView.hasFocus).toBe(true);
    expect(editor.source.endsWith("\n\nafter")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("table boundaries and source entry", () => {
  it("moves across horizontal and vertical cell boundaries and leaves with Escape or reverse Tab", async () => {
    const { editor, onError } = await mount();
    activate(editor, 0, 0);
    press(editor, "Tab", { shiftKey: true });
    expect(editor.inputView).toBe(editor.view);
    activate(editor, 0, 1);
    press(editor, "Enter");
    expect(editor.inputView.state.doc.toString()).toBe("$x$");
    press(editor, "ArrowUp");
    expect(editor.inputView.state.doc.toString()).toBe("Value");
    press(editor, "ArrowLeft");
    expect(editor.inputView.state.doc.toString()).toBe("Name");
    editor.inputView.dispatch({ selection: { anchor: 4 } });
    press(editor, "ArrowRight");
    expect(editor.inputView.state.doc.toString()).toBe("Value");
    press(editor, "Escape");
    expect(editor.inputView).toBe(editor.view);
    expect(editor.view.hasFocus).toBe(true);
    expect(editor.source).toBe(source);
    expect(onError).not.toHaveBeenCalled();
  });

  it("restores a cell from its global source offset and targets a cell at pointer coordinates", async () => {
    const { editor, onError } = await mount();
    const position = source.indexOf("one") + 1;
    editor.focusAt(position);
    expect(editor.selectionStart).toBe(position);
    expect(editor.inputView.state.doc.toString()).toBe("one");
    expect(editor.inputView.state.selection.main.head).toBe(1);
    const cell = editor.view.contentDOM.querySelector<HTMLButtonElement>(
      'button[data-inkbook-table-row="1"][data-inkbook-table-column="1"]',
    )!;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(cell);
    editor.focusAt({ x: 20, y: 30 });
    expect(editor.inputView.state.doc.toString()).toBe("$x$");
    expect(editor.inputView.hasFocus).toBe(true);
    expect(editor.source).toBe(source);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("owned table context actions", () => {
  it("inserts and removes rows and columns while preserving existing cells and column alignment", async () => {
    const { editor, settle, onError } = await mount(source, true);
    activate(editor, 1, 1);
    choose(editor, "Insert row above");
    await settle();
    expect(parsedTable(editor).table.rows).toHaveLength(3);
    choose(editor, "Insert row below");
    await settle();
    expect(parsedTable(editor).table.rows).toHaveLength(4);
    choose(editor, "Delete row");
    await settle();
    expect(parsedTable(editor).table.rows).toHaveLength(3);
    choose(editor, "Insert column left");
    await settle();
    expect(parsedTable(editor).table.alignments).toHaveLength(3);
    choose(editor, "Align column center");
    await settle();
    expect(parsedTable(editor).table.alignments[1]).toBe("center");
    choose(editor, "Insert column right");
    await settle();
    expect(parsedTable(editor).table.alignments).toHaveLength(4);
    choose(editor, "Delete column");
    await settle();
    const { block, table } = parsedTable(editor);
    expect(table.alignments).toEqual(["left", "center", "right"]);
    expect(table.rows).toHaveLength(3);
    expect(block.runs.some((run) => run.text === "one")).toBe(true);
    expect(block.runs.some((run) => run.kind === "math" && run.latex === "x")).toBe(true);
    expect(editor.source.endsWith("\n\nafter")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    activate(editor, 1, 1);
    press(editor, "Escape");
    clickAction(editor, "Table options");
    expect(
      document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')?.textContent,
    ).toBe("Align column center");
  });

  it("queues a structural action during pending cell input and applies it to the latest source", async () => {
    const { editor, settle, onError } = await mount(source, true);
    activate(editor, 1, 0);
    editor.inputView.dispatch({ changes: { from: 0, insert: "new " } });
    choose(editor, "Insert row below");
    await settle();
    expect(editor.source).toContain("| new one | $x$ |");
    expect(parsedTable(editor).table.rows).toHaveLength(3);
    expect(editor.inputView.state.doc.toString()).toBe("");
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["row", "column"])("removes a table through deletion of its final %s", async (kind) => {
    const { editor, settle, onError } = await mount("| Only |\n| --- |\n\nafter", true);
    activate(editor, 0, 0);
    choose(editor, kind === "row" ? "Delete row" : "Delete column");
    await settle();
    expect(editor.source.trim()).toBe("after");
    expect(editor.inputView).toBe(editor.view);
    expect(editor.view.contentDOM.querySelector("table")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("table source and formatting actions", () => {
  it("appends rows and columns through their native buttons without losing inline content", async () => {
    const rich = source.replace("one", "**one**");
    const { editor, settle, renderTable, onError } = await mount(rich);
    clickAction(editor, "Add row");
    await settle();
    expect(parsedTable(editor).table.rows).toHaveLength(3);
    clickAction(editor, "Add column");
    await settle();
    const { block, table } = parsedTable(editor);
    expect(table.alignments).toEqual(["left", "right", "left"]);
    expect(table.rows.map((row) => row.cells.length)).toEqual([3, 3, 3]);
    expect(block.runs.some((run) => run.text === "one" && run.style.bold)).toBe(true);
    expect(block.runs.some((run) => run.kind === "math" && run.latex === "x")).toBe(true);
    expect(editor.source.endsWith("\n\nafter")).toBe(true);
    expect(renderTable.mock.calls.every((call) => call[2].availableWidth === 100)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("formats a selected cell through the shared style API while retaining its input", async () => {
    const { editor, container, settle, onError } = await mount();
    const input = activate(editor, 1, 0);
    input.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(onError).not.toHaveBeenCalled();
    const menuControl = document.createElement("button");
    menuControl.textContent = "Style";
    container.append(menuControl);
    menuControl.focus();
    expect(editor.applyStyle("text-bold", true)).toBe(true);
    await settle();
    expect(editor.source).toBe(source.replace("one", "**one**"));
    expect(onError).not.toHaveBeenCalled();
    const color = { type: "rgba", value: "#112233FF" } as const;
    expect(editor.applyStyle("text-color", color)).toBe(true);
    await settle();
    const { block } = parsedTable(editor);
    expect(block.runs.find((run) => run.text === "one")?.style).toMatchObject({
      bold: true,
      color,
    });
    expect(editor.ranges).toContainEqual({
      start: editor.source.indexOf("one"),
      end: editor.source.indexOf("one") + 3,
      style: { color },
    });
    expect(editor.inputView).toBe(input);
    editor.focusSelectionPreserved();
    expect(input.hasFocus).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("delegates undo and redo to the document history without an independent cell history", async () => {
    const { editor, settle, onUndoRedo, onError } = await mount();
    activate(editor, 1, 0);
    editor.inputView.dispatch({ changes: { from: 0, to: 3, insert: "changed" } });
    await settle();
    press(editor, "z", { ctrlKey: true });
    press(editor, "Z", { ctrlKey: true, shiftKey: true, code: "KeyZ", keyCode: 90 });
    expect(onUndoRedo.mock.calls).toEqual([[false], [true]]);
    expect(editor.source).toBe(source.replace("one", "changed"));
    expect(editor.inputView.state.doc.toString()).toBe("changed");
    expect(onError).not.toHaveBeenCalled();
  });

  it("formats directly with Mod-b while the cell keeps native focus", async () => {
    const { editor, settle, onError } = await mount();
    const input = activate(editor, 1, 0);
    input.dispatch({ selection: { anchor: 0, head: 3 } });
    press(editor, "b", { ctrlKey: true, code: "KeyB", keyCode: 66 });
    await settle();
    expect(editor.source).toBe(source.replace("one", "**one**"));
    expect(editor.inputView).toBe(input);
    expect(input.hasFocus).toBe(true);
    press(editor, "b", { ctrlKey: true, code: "KeyB", keyCode: 66 });
    await settle();
    expect(editor.source).toBe(source);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("cell source recovery", () => {
  it("retains leading and trailing spaces across preparation before the next word", async () => {
    const { editor, settle, onError } = await mount();
    const input = activate(editor, 1, 0);
    input.dispatch({
      changes: [
        { from: 0, insert: " " },
        { from: 3, insert: " " },
      ],
      selection: { anchor: 5 },
    });
    await settle();
    expect(input.state.doc.toString()).toBe(" one ");
    input.dispatch({ changes: { from: 5, insert: "two" } });
    await settle();
    expect(editor.source).toBe(source.replace("one", " one two"));
    const cell = parsedTable(editor).table.rows[1]!.cells[0]!;
    expect(editor.source.slice(cell.contentStart, cell.contentEnd)).toBe("one two");
    expect(editor.inputView).toBe(input);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects a pipe paste whose escaped source exceeds capacity and restores the cell", async () => {
    const { editor, settle, onError } = await mount();
    const input = activate(editor, 1, 0);
    input.dispatch({
      changes: { from: 0, to: 3, insert: "|".repeat(50_001) },
      userEvent: "input.paste",
    });
    await settle();
    expect(editor.source).toBe(source);
    expect(editor.inputView).toBe(input);
    expect(input.state.doc.toString()).toBe("one");
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.lastCall?.[0]).toBeInstanceOf(RangeError);
  });
});

describe("native input across rendered table selections", () => {
  it("replaces the complete canonical selection and disposes the rendered table", async () => {
    const { editor, settle, onError } = await mount();
    replaceOuterSelection(editor, 0, editor.source.length);
    await settle();
    expect(editor.source).toBe("Replacement");
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBeNull();
    expect(document.body.querySelector(".inkbook-text-table-controls-layer")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("replaces a partial table selection while preserving unselected source", async () => {
    const { editor, settle, onError } = await mount();
    const start = source.indexOf("one");
    const end = source.indexOf("$x$") + 3;
    replaceOuterSelection(editor, start, end);
    await settle();
    expect(editor.source).toBe(source.slice(0, start) + "Replacement" + source.slice(end));
    expect(onError).not.toHaveBeenCalled();
  });

  it("leaves ordinary text and nested cell input to their native editor", async () => {
    const { editor, onError } = await mount();
    const after = source.indexOf("after");
    editor.view.dispatch({ selection: { anchor: after, head: source.length } });
    const ordinary = insertText(editor.view.contentDOM, "word");
    expect(ordinary.defaultPrevented).toBe(false);
    const input = activate(editor, 1, 0);
    input.dispatch({ selection: { anchor: 0, head: 3 } });
    const nested = insertText(input.contentDOM, "word");
    expect(nested.defaultPrevented).toBe(false);
    expect(editor.inputView).toBe(input);
    expect(editor.source).toBe(source);
    expect(onError).not.toHaveBeenCalled();
  });

  it("leaves an active composition across a table selection under native IME ownership", async () => {
    const { editor, onError } = await mount();
    editor.view.dispatch({ selection: { anchor: 0, head: source.length } });
    const composition = new InputEvent("beforeinput", {
      inputType: "insertCompositionText",
      data: "あ",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    editor.view.contentDOM.dispatchEvent(composition);
    expect(composition.defaultPrevented).toBe(false);
    expect(editor.source).toBe(source);
    expect(onError).not.toHaveBeenCalled();
  });
});

it("materializes a missing body cell without changing content outside its table", async () => {
  const sparse = "| A | B | C |\n| --- | --- | --- |\n| kept\n\noutside | untouched";
  const { editor, settle, onError } = await mount(sparse);
  const prefix = sparse.slice(0, sparse.indexOf("\n| kept"));
  const suffix = sparse.slice(sparse.indexOf("\n\noutside"));
  const button = editor.view.contentDOM.querySelector<HTMLButtonElement>(
    'button[data-inkbook-table-row="1"][data-inkbook-table-column="2"]',
  );
  expect(button).not.toBeNull();
  activate(editor, 1, 0);
  editor.inputView.dispatch({ changes: { from: 0, insert: "changed " } });
  button!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(editor.inputView).not.toBe(editor.view);
  editor.inputView.dispatch({ changes: { from: 0, insert: "new" } });
  await settle();
  const { table } = parsedTable(editor);
  expect(table.rows[1]!.cells).toHaveLength(3);
  const cell = table.rows[1]!.cells[2]!;
  expect(editor.source.slice(cell.contentStart, cell.contentEnd)).toBe("new");
  expect(editor.source).toContain("| changed kept |");
  expect(editor.source.startsWith(prefix)).toBe(true);
  expect(editor.source.endsWith(suffix)).toBe(true);
  expect(onError).not.toHaveBeenCalled();
});

it("retains the active cell and source selection while floating controls suspend for a geometry gesture", async () => {
  const { editor, settle, onError } = await mount();
  const cell = activate(editor, 1, 0);
  const selection = cell.state.selection;
  const native = editor.view.state.doc;
  const layer = document.querySelector<HTMLElement>(".inkbook-text-table-controls-layer")!;
  editor.setGeometrySuspended(true);
  expect(layer.hidden).toBe(true);
  expect(layer.inert).toBe(true);
  expect(editor.inputView).toBe(cell);
  expect(cell.state.selection.eq(selection)).toBe(true);
  expect(editor.view.state.doc).toBe(native);
  editor.setGeometrySuspended(false);
  expect(layer.inert).toBe(false);
  expect(editor.inputView).toBe(cell);
  expect(cell.hasFocus).toBe(true);
  cell.dispatch({ changes: { from: 0, insert: "resumed " } });
  await settle();
  expect(editor.source).toContain("| resumed one |");
  expect(onError).not.toHaveBeenCalled();
});
