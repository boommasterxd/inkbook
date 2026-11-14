// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  activate,
  disposeTableEditors,
  mount,
  parsedTable,
  TABLE_SOURCE as source,
} from "../../../../fixtures/obsidian/text-table-editor";
import { openTableMarkdownSource } from "../../../../fixtures/obsidian/text-table-source-action";

afterEach(disposeTableEditors);

describe("native Markdown selection across tables", () => {
  it("reveals and copies the complete source, then restores the table when selection collapses", async () => {
    const { editor, settle, expectUnchangedPreview } = await mount();
    editor.view.dispatch({ selection: { anchor: 0, head: source.length } });
    expect(editor.inputView).toBe(editor.view);
    expect(editor.view.contentDOM.querySelector("table")).toBeNull();
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-source-control")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain("| :--- | ---: |");
    expect(editor.view.state.sliceDoc(0, source.length)).toBe(source);
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(source.length);
    const clipboard = new DataTransfer();
    document.getSelection()!.selectAllChildren(editor.view.contentDOM);
    editor.view.contentDOM.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: clipboard, bubbles: true, cancelable: true }),
    );
    expect(clipboard.getData("text/plain")).toBe(source);
    await settle();
    expect(editor.view.contentDOM.querySelector("table")).toBeNull();
    expect(editor.selectionEnd).toBe(source.length);
    editor.view.dispatch({ selection: { anchor: source.length } });
    await expectUnchangedPreview();
  });

  it("reveals a full table for a selection spanning ordinary text and part of its source", async () => {
    const content = `before\n\n${source}`;
    const { editor, settle, expectUnchangedPreview } = await mount(content);
    const start = content.indexOf("before") + 2;
    const end = content.indexOf("one") + 2;
    editor.view.dispatch({ selection: { anchor: start, head: end } });
    await settle();
    expect(editor.view.contentDOM.querySelector("table")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain("| one |");
    expect(editor.view.contentDOM.textContent).toContain("| :--- | ---: |");
    expect(editor.view.state.sliceDoc(start, end)).toBe(content.slice(start, end));
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([start, end]);
    expect(editor.source).toBe(content);
    editor.view.dispatch({
      selection: { anchor: content.indexOf("Value") + 1, head: content.length - 2 },
    });
    expect(editor.view.contentDOM.querySelector("table")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain("| Name | Value |");
    editor.view.dispatch({ selection: { anchor: content.length } });
    await expectUnchangedPreview();
  });

  it("keeps tables rendered when a selection only touches either source boundary", async () => {
    const content = `before\n\n${source}`;
    const { editor, onError } = await mount(content);
    const { block } = parsedTable(editor);
    for (const selection of [
      { anchor: 0, head: block.start },
      { anchor: block.end, head: content.length },
      { anchor: block.start },
    ]) {
      editor.view.dispatch({ selection });
      expect(editor.view.contentDOM.querySelector("table")).not.toBeNull();
      expect(editor.source).toBe(content);
    }
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("table source selection ownership", () => {
  it("keeps a nested cell selection rendered across bold formatting and preview refresh", async () => {
    const { editor, settle, onError } = await mount();
    const input = activate(editor, 1, 0);
    input.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(editor.view.contentDOM.querySelector("table")).not.toBeNull();
    expect(editor.inputView).toBe(input);
    expect(editor.applyStyle("text-bold", true)).toBe(true);
    await settle();
    expect(editor.source).toBe(source.replace("one", "**one**"));
    expect(editor.inputView).toBe(input);
    expect(
      input.state.sliceDoc(input.state.selection.main.from, input.state.selection.main.to),
    ).toBe("one");
    expect(editor.view.contentDOM.querySelector("table")).not.toBeNull();
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-source-control")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("extends an outer selection to a cell source position with Shift-click", async () => {
    const content = `before\n\n${source}`;
    const { editor, onError } = await mount(content);
    editor.view.focus();
    editor.view.dispatch({ selection: { anchor: 2 } });
    const target = editor.view.contentDOM.querySelector<HTMLButtonElement>(
      'button[data-inkbook-table-row="1"][data-inkbook-table-column="0"]',
    )!;
    target.dispatchEvent(
      new MouseEvent("pointerdown", {
        button: 0,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editor.inputView).toBe(editor.view);
    expect(editor.view.state.selection.main.anchor).toBe(2);
    expect(editor.view.state.selection.main.head).toBe(content.indexOf("one"));
    expect(editor.view.contentDOM.querySelector("table")).toBeNull();
    expect(editor.source).toBe(content);
    expect(onError).not.toHaveBeenCalled();
  });

  it("retains an explicit return control for source opened through the table action", async () => {
    const { editor, settle, expectUnchangedPreview } = await mount(source, true);
    openTableMarkdownSource(editor);
    await settle();
    expect(editor.view.contentDOM.querySelector("table")).toBeNull();
    const control = [...editor.view.contentDOM.querySelectorAll("button")].find(
      (button) => button.textContent === "Return to table",
    );
    expect(control).toBeDefined();
    control!.focus();
    control!.click();
    await expectUnchangedPreview();
  });
});
