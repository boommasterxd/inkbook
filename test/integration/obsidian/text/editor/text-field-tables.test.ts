// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Transaction } from "@codemirror/state";
import {
  TextFieldEditor,
  type TextFieldEditorOptions,
} from "../../../../../src/obsidian/text/editor/text-field-editor";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { assertAccessibleSemantics } from "../../../../fixtures/accessibility";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import { setTextTableSource } from "../../../../../src/obsidian/text/editor/text-table-mode";
import { setTextViewport } from "../../../../../src/obsidian/text/editor/text-preview-decorations";

const source = "| Name | Value |\n| :--- | ---: |\n| **one** | $x$ |\n\nafter";
const editors: TextFieldEditor[] = [];

function mount(options: Partial<TextFieldEditorOptions> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const frames = new ManualFrameScheduler();
  const renderTable = vi.fn<NonNullable<TextFieldEditorOptions["renderTable"]>>(async () => {
    const node = document.createElement("div");
    node.textContent = "Canonical table";
    return { node, rowHeights: [25, 35] };
  });
  const onChange = vi.fn<TextFieldEditorOptions["onChange"]>();
  const onError = vi.fn();
  const editor = new TextFieldEditor({
    container,
    element: { ...textElement(), source },
    scheduler: workSchedulerFromFrames(frames),
    renderTable,
    onChange,
    onError,
    onFinish: vi.fn(),
    ...options,
  });
  editors.push(editor);
  editor.view.dispatch({ selection: { anchor: editor.source.length } });
  const flush = () => {
    while (frames.pendingCount) frames.runNext();
  };
  flush();
  return { editor, renderTable, onChange, onError, flush };
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  document.body.replaceChildren();
});

describe("native table Live Preview", () => {
  it("retains the active cell when fine visible ranges exclude the rendered table source", async () => {
    const { editor, flush, onError } = mount();
    await Promise.resolve();
    const widget = editor.view.contentDOM.querySelector(".inkbook-text-table-widget");
    const button = widget?.querySelector<HTMLButtonElement>("td button");
    button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const cell = editor.inputView;
    expect(cell).not.toBe(editor.view);
    vi.spyOn(editor.view, "viewport", "get").mockImplementation(() => ({
      from: 0,
      to: editor.view.state.doc.length,
    }));
    vi.spyOn(editor.view, "visibleRanges", "get").mockImplementation(() => [
      {
        from: editor.view.state.doc.length - 5,
        to: editor.view.state.doc.length,
      },
    ]);
    editor.view.dispatch({
      effects: setTextViewport.of([{ start: source.length - 5, end: source.length }]),
    });
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBe(widget);
    cell.dispatch({ changes: { from: 0, insert: "new " } });
    await editor.flushChanges();
    flush();
    await Promise.resolve();
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBe(widget);
    expect(editor.inputView).toBe(cell);
    expect(cell.hasFocus).toBe(true);
    expect(editor.source).toContain("| new **one** | $x$ |");
    expect(onError).not.toHaveBeenCalled();
  });

  it("retains canonical paint and semantic headers across unrelated caret moves", async () => {
    const { editor, renderTable, onChange, onError } = mount();
    await Promise.resolve();
    const widget = editor.view.contentDOM.querySelector<HTMLElement>(".inkbook-text-table-widget");
    expect(widget?.style.marginBottom).toBe("28px");
    expect(widget?.querySelectorAll("th[scope=col]")).toHaveLength(2);
    expect(widget?.querySelectorAll("td")).toHaveLength(2);
    expect(widget?.querySelector("[aria-hidden=true]")?.textContent).toBe("Canonical table");
    await assertAccessibleSemantics(widget!, ["button-name"]);
    editor.view.dispatch({ selection: { anchor: source.length - 1 } });
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBe(widget);
    expect(renderTable).toHaveBeenCalledOnce();
    expect(renderTable.mock.calls[0]?.[2]).toEqual({ availableWidth: 100 });
    expect(editor.source).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("edits the clicked cell while retaining the table and publishes canonical source", async () => {
    const { editor, flush, onChange, onError } = mount();
    await Promise.resolve();
    const cell = editor.view.contentDOM.querySelectorAll<HTMLButtonElement>("td button")[1];
    const widget = editor.view.contentDOM.querySelector(".inkbook-text-table-widget");
    cell?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(editor.selectionStart).toBe(source.indexOf("$x$"));
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBe(widget);
    expect(editor.inputView).not.toBe(editor.view);
    const input = editor.inputView;
    expect(editor.source).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
    editor.inputView.dispatch({ changes: { from: 1, insert: "y+" } });
    await editor.flushChanges();
    flush();
    expect(editor.source).toBe(source.replace("$x$", "$y+x$"));
    expect(onChange.mock.lastCall?.[0].source).toBe(editor.source);
    await Promise.resolve();
    expect(editor.inputView).toBe(input);
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBe(widget);
    expect(onError).not.toHaveBeenCalled();
  });

  it("opens an empty cell through keyboard activation with an explicit accessible label", async () => {
    const emptySource = "| A | B |\n| --- | --- |\n| a | |\n\nafter";
    const { editor } = mount({
      element: { ...textElement(), source: emptySource },
      tableCellLabel: "Edit empty table cell",
    });
    await Promise.resolve();
    const button = editor.view.contentDOM.querySelectorAll<HTMLButtonElement>("td button")[1];
    expect(button?.textContent).toBe("Edit empty table cell");
    button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(editor.selectionStart).toBe(emptySource.indexOf(" |\n\n") + 1);
    expect(editor.inputView.hasFocus).toBe(true);
    expect(editor.source).toBe(emptySource);
  });
});

describe("explicit table source mode", () => {
  it("aborts rendering on explicit source mode and ignores the obsolete visual result", async () => {
    let finish: ((value: { node: HTMLElement; rowHeights: readonly number[] }) => void) | undefined;
    let signal: AbortSignal | undefined;
    const { editor, onError } = mount({
      renderTable: (_block, abort) => {
        signal = abort;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const widget = editor.view.contentDOM.querySelector(".inkbook-text-table-widget");
    editor.view.dispatch({
      selection: { anchor: 3 },
      effects: setTextTableSource.of({ start: 0, end: source.indexOf("\n\n"), source: true }),
    });
    expect(signal?.aborted).toBe(true);
    const node = document.createElement("div");
    node.textContent = "Late";
    finish?.({ node, rowHeights: [20, 20] });
    await Promise.resolve();
    expect(widget?.textContent).not.toContain("Late");
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns from explicit source to preview without changing the source", async () => {
    const { editor } = mount();
    await Promise.resolve();
    editor.view.dispatch({
      selection: { anchor: 3 },
      effects: setTextTableSource.of({ start: 0, end: source.indexOf("\n\n"), source: true }),
    });
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBeNull();
    const toggle = [...editor.view.contentDOM.querySelectorAll("button")].find(
      (button) => button.textContent === "Table preview",
    );
    expect(toggle).toBeDefined();
    toggle?.click();
    await Promise.resolve();
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).not.toBeNull();
    expect(editor.source).toBe(source);
  });

  it("keeps a newly typed table in source until the caret leaves but renders pasted tables", async () => {
    const { editor, flush } = mount({ element: { ...textElement(), source: "" } });
    editor.view.dispatch({
      changes: { from: 0, insert: source },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    await editor.flushChanges();
    flush();
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBeNull();
    editor.view.dispatch({ selection: { anchor: source.length } });
    await Promise.resolve();
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).not.toBeNull();
    const pasted = mount({ element: { ...textElement(), source: "" } });
    pasted.editor.view.dispatch({
      changes: { from: 0, insert: source },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of("input.paste"),
    });
    await pasted.editor.flushChanges();
    pasted.flush();
    await Promise.resolve();
    expect(
      pasted.editor.view.contentDOM.querySelector(".inkbook-text-table-widget"),
    ).not.toBeNull();
  });
});

describe("table source failure recovery", () => {
  it("keeps invalid source editable after a table separator is removed", async () => {
    const { editor, flush, onError } = mount();
    await Promise.resolve();
    const from = source.indexOf(":---");
    editor.view.dispatch({
      selection: { anchor: from },
      effects: setTextTableSource.of({ start: 0, end: source.indexOf("\n\n"), source: true }),
    });
    editor.view.dispatch({ changes: { from, to: from + 4, insert: "--" } });
    await editor.flushChanges();
    flush();
    expect(editor.source).toBe(source.replace(":---", "--"));
    expect(editor.inputView).toBe(editor.view);
    expect(editor.view.contentDOM.querySelector(".inkbook-text-table-widget")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps malformed table syntax editable without invoking canonical table preparation", () => {
    const malformed = "| A | B |\n| -- | --- |\n| x | y |\n\nafter";
    const { editor, renderTable } = mount({ element: { ...textElement(), source: malformed } });
    expect(editor.view.contentDOM.querySelector("table")).toBeNull();
    expect(renderTable).not.toHaveBeenCalled();
    expect(editor.source).toBe(malformed);
  });

  it("reports canonical rendering failures while keeping every source cell reachable", async () => {
    const failure = new Error("Unavailable table font resource.");
    const { editor, onError } = mount({
      renderTable: async () => {
        throw failure;
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    const widget = editor.view.contentDOM.querySelector(".inkbook-text-table-widget");
    expect(widget?.getAttribute("aria-busy")).toBeNull();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    const button = widget?.querySelector("button");
    button?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(editor.selectionStart).toBe(source.indexOf("Name"));
    expect(editor.source).toBe(source);
  });
});
