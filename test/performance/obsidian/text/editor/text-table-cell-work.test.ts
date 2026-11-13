// @vitest-environment happy-dom

import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { afterEach, expect, it, vi } from "vitest";
import { TextFieldEditor } from "../../../../../src/obsidian/text/editor/text-field-editor";
import type {
  TextFieldEditorOptions,
  TextTableRowRange,
} from "../../../../../src/obsidian/text/editor/text-field-editor-types";
import { TextTableViewport } from "../../../../../src/obsidian/text/editor/text-table-viewport";
import { TextTableTarget } from "../../../../../src/obsidian/text/editor/text-table-target";
import { TextTableHover } from "../../../../../src/obsidian/text/editor/text-table-hover";
import { observeSchemaArray } from "../../../../fixtures/domain/schema-array-work";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import * as markdownTables from "../../../../../src/domain/text/markdown-tables";
import * as markdownParser from "../../../../../src/domain/text/markdown-parser";
import {
  captureTextTableMeasurements,
  mountTextTableViewport,
} from "../../../../fixtures/obsidian/text-table-viewport";

const source = `| Name | Value |\n| --- | --- |\n${Array.from(
  { length: 1_000 },
  (_, index) => `| row ${String(index)} | value ${String(index)} |`,
).join("\n")}\n\nafter`;
const editors: TextFieldEditor[] = [];

async function mount(content = source) {
  const container = mountTextTableViewport();
  const parsed = parseTextMarkdown(content, { style: textElement().style });
  const block = parsed.blocks.find((candidate) => candidate.table)!;
  const runs = observeSchemaArray(block.runs);
  const rows = observeSchemaArray(block.table!.rows);
  const cached = {
    ...parsed,
    blocks: parsed.blocks.map((candidate) =>
      candidate === block
        ? { ...candidate, runs: runs.observed, table: { ...candidate.table!, rows: rows.observed } }
        : candidate,
    ),
  };
  const frames = new ManualFrameScheduler();
  const signals: AbortSignal[] = [];
  const heights = observeSchemaArray(Array<number>(1_001).fill(20));
  const renderRows = vi.fn(async (_range: TextTableRowRange, _signal: AbortSignal) => {});
  const renderTable = vi.fn<NonNullable<TextFieldEditorOptions["renderTable"]>>(
    async (_block, signal) => {
      signals.push(signal);
      return { node: document.createElement("span"), rowHeights: heights.observed, renderRows };
    },
  );
  const onChange = vi.fn<TextFieldEditorOptions["onChange"]>();
  const onError = vi.fn();
  const editor = new TextFieldEditor({
    container,
    element: { ...textElement(), source: content, width: 200 },
    scheduler: workSchedulerFromFrames(frames),
    parsedDocument: () => cached,
    renderTable,
    onChange,
    onFinish: vi.fn(),
    onError,
  });
  editors.push(editor);
  // Native CM excludes replaced table source from fine ranges; coarse viewport still contains it.
  vi.spyOn(editor.view, "visibleRanges", "get").mockImplementation(() => [
    { from: editor.view.state.doc.length - 5, to: editor.view.state.doc.length },
  ]);
  vi.spyOn(editor.view, "viewport", "get").mockImplementation(() => ({
    from: 0,
    to: editor.view.state.doc.length,
  }));
  editor.view.dispatch({ selection: { anchor: content.length } });
  frames.runNext();
  const { pending, widget } = captureTextTableMeasurements(editor.view);
  const bounds = vi
    .spyOn(widget, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, -16_000, 200, 20_020));
  const settle = async () => {
    let idle = 0;
    for (let turn = 0; turn < 100; turn += 1) {
      const measures = pending
        .splice(0)
        .filter((request) => request.key instanceof TextTableViewport);
      for (const request of measures) request.write?.(request.read(editor.view), editor.view);
      if (frames.pendingCount) frames.runNext();
      idle = !frames.pendingCount && measures.length === 0 ? idle + 1 : 0;
      await Promise.resolve();
      if (idle === 3) return;
    }
    throw new Error(
      `Windowed cell work did not settle: ${String(frames.pendingCount)} frames, ${String(pending.length)} measures, ${String(renderTable.mock.calls.length)} prepares, ${String(renderRows.mock.calls.length)} paints, ${String(onError.mock.lastCall?.[0])}.`,
    );
  };
  await settle();
  return {
    editor,
    widget,
    settle,
    frames,
    runs,
    rows,
    heights,
    renderTable,
    renderRows,
    signals,
    onChange,
    onError,
    bounds,
    pending,
  };
}

function activate(editor: TextFieldEditor): EditorView {
  const cell = editor.view.contentDOM.querySelector<HTMLButtonElement>(
    'button[data-inkbook-table-row="800"][data-inkbook-table-column="0"]',
  );
  if (!cell) throw new Error("Expected the far-scrolled cell in the mounted row window.");
  cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(editor.inputView).not.toBe(editor.view);
  return editor.inputView;
}

function tab(editor: TextFieldEditor, shiftKey = false): void {
  editor.inputView.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("owns one active hover corridor without table-count pointer fanout and releases its listeners", () => {
  const hover = new TextTableHover();
  const node = document.createElement("div");
  const layer = document.createElement("div");
  const subscriptions = vi.spyOn(document, "addEventListener");
  const targets = Array.from({ length: 2_000 }, () => ({
    node,
    layer,
    bounds: vi.fn(() => ({ left: 0, top: 0, right: 100, bottom: 100 })),
    changed: vi.fn(),
  }));
  const last = targets[targets.length - 1]!;
  expect(subscriptions).not.toHaveBeenCalled();
  hover.enter(targets[0]!);
  hover.enter(last);
  const moves = subscriptions.mock.calls.filter(([type]) => type === "pointermove");
  expect(moves).toHaveLength(2);
  const signals = moves.map(([, , options]) => (options as AddEventListenerOptions).signal!);
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  const rect = vi.spyOn(node, "getBoundingClientRect");
  for (let step = 0; step < 100; step++)
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 50, clientY: 50 }));
  expect(last.bounds).toHaveBeenCalledTimes(100);
  expect(targets.slice(0, -1).every((target) => target.bounds.mock.calls.length === 0)).toBe(true);
  expect(rect).not.toHaveBeenCalled();
  expect(subscriptions.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(2);
  document.documentElement.dispatchEvent(new PointerEvent("pointerleave"));
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(last.changed).toHaveBeenLastCalledWith(false);
  document.dispatchEvent(new PointerEvent("pointermove", { clientX: 50, clientY: 50 }));
  expect(last.bounds).toHaveBeenCalledTimes(100);
});

it("bounds target preview geometry and DOM ownership independently of table row count", () => {
  for (const rows of [2, 1_001]) {
    const node = document.createElement("div");
    document.body.append(node);
    const create = vi.spyOn(document, "createElementNS");
    const target = new TextTableTarget(node);
    expect(create).toHaveBeenCalledTimes(4);
    expect(node.querySelectorAll("svg")).toHaveLength(1);
    expect(node.querySelector("svg")!.children).toHaveLength(3);
    expect(node.querySelectorAll("rect, path")).toHaveLength(3);
    const rowTop = vi.fn((index: number) => index * 20);
    const layout = { width: 200, rows, columns: 2, rowTop };
    const cell = { row: rows - 1, column: 1 };
    const action = { kind: "insert-row", row: cell.row, placement: "after" } as const;
    const writes = vi.spyOn(Element.prototype, "setAttribute");
    const removals = vi.spyOn(Element.prototype, "removeAttribute");
    target.show(layout, cell, action);
    expect(rowTop.mock.calls.length).toBeGreaterThan(0);
    expect(rowTop.mock.calls.length).toBeLessThanOrEqual(4);
    expect(writes).toHaveBeenCalled();
    expect(removals).toHaveBeenCalled();
    rowTop.mockClear();
    writes.mockClear();
    removals.mockClear();
    target.show(layout, cell, action);
    expect(rowTop.mock.calls.length).toBeLessThanOrEqual(4);
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(4);
    target.hide();
    writes.mockClear();
    target.hide();
    expect(writes).not.toHaveBeenCalled();
    target.dispose();
    expect(node.childElementCount).toBe(0);
    create.mockRestore();
    writes.mockRestore();
    removals.mockRestore();
    node.remove();
  }
});

it("keeps far-row activation and caret work local without rebuilding layouts or cell editors", async () => {
  const state = await mount();
  const { editor, widget, settle, runs, heights, renderTable, renderRows, onError } = state;
  runs.work.indexedReads = 0;
  heights.work.indexedReads = 0;
  const createElement = vi.spyOn(document, "createElement");
  const flatten = vi.spyOn(editor.view.state.doc, "toString");
  const input = activate(editor);
  await settle();
  // A binary range lookup plus the matching run and its successor admits this one-cell preview.
  expect(runs.work.indexedReads).toBeGreaterThan(0);
  expect(runs.work.indexedReads).toBeLessThanOrEqual(
    Math.ceil(Math.log2(runs.observed.length)) + 3,
  );
  expect(heights.work.indexedReads).toBe(0);
  expect(flatten).not.toHaveBeenCalled();
  const paints = renderRows.mock.calls.length;
  const reads = runs.work.indexedReads;
  input.dispatch({ selection: { anchor: 0 } });
  input.dispatch({ selection: { anchor: 7 } });
  input.dispatch({ selection: { anchor: 0, head: 7 } });
  await settle();
  expect(editor.inputView).toBe(input);
  expect(runs.work.indexedReads).toBe(reads);
  expect(heights.work.indexedReads).toBe(0);
  expect(renderTable).toHaveBeenCalledOnce();
  expect(renderRows).toHaveBeenCalledTimes(paints);
  expect(flatten).not.toHaveBeenCalled();
  const createdCells = createElement.mock.results.filter(
    (result) => result.type === "return" && result.value === input.dom,
  );
  expect(createdCells).toHaveLength(1);
  expect(widget.querySelectorAll("button[data-inkbook-table-column]").length).toBeLessThanOrEqual(
    22,
  );
  expect(
    widget.ownerDocument.body.querySelectorAll(".inkbook-text-table-controls button"),
  ).toHaveLength(3);
  for (const [range] of renderRows.mock.calls)
    expect(range.to - range.from).toBeLessThanOrEqual(10);
  expect(onError).not.toHaveBeenCalled();
});

it("coalesces the latest cell source and releases editor, render and pending measurement ownership", async () => {
  const state = await mount();
  const {
    editor,
    widget,
    settle,
    frames,
    renderTable,
    signals,
    onChange,
    onError,
    bounds,
    pending,
  } = state;
  const input = activate(editor);
  await settle();
  input.dispatch({ changes: { from: 0, insert: "a" } });
  input.dispatch({ changes: { from: 1, insert: "b" } });
  await editor.flushChanges();
  await settle();
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange.mock.lastCall?.[0].source).toContain("| abrow 799 | value 799 |");
  expect(renderTable).toHaveBeenCalledTimes(2);
  expect(editor.inputView).toBe(input);
  expect(input.state.doc.toString()).toBe("abrow 799");
  input.dispatch({ selection: { anchor: 1 } });
  expect(frames.pendingCount).toBeGreaterThan(0);
  editor.requestViewportMeasure();
  const reads = bounds.mock.calls.length;
  editor.dispose();
  expect(frames.pendingCount).toBe(0);
  expect(input.dom.isConnected).toBe(false);
  expect(widget.isConnected).toBe(false);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  for (const request of pending.splice(0)) request.write?.(request.read(editor.view), editor.view);
  await Promise.resolve();
  expect(bounds).toHaveBeenCalledTimes(reads);
  expect(onError).not.toHaveBeenCalled();
});

it("maps immediate navigation and input across prepared cells without synchronous full-field work", async () => {
  const { editor, settle, renderTable, onChange, onError, heights } = await mount();
  const first = activate(editor);
  await settle();
  const wholeParse = vi.spyOn(markdownParser, "parseTextMarkdownSteps");
  const rowParse = vi.spyOn(markdownTables, "textTableBodySteps");
  heights.work.indexedReads = 0;
  first.dispatch({ changes: { from: 7, insert: " first" } });
  const firstFlatten = vi.spyOn(editor.view.state.doc, "toString");
  tab(editor);
  const second = editor.inputView;
  expect(second.state.doc.toString()).toBe("value 799");
  second.dispatch({ changes: { from: 0, to: 9, insert: "second" } });
  const secondFlatten = vi.spyOn(editor.view.state.doc, "toString");
  tab(editor, true);
  expect(editor.inputView.state.doc.toString()).toBe("row 799 first");
  expect(wholeParse).not.toHaveBeenCalled();
  expect(rowParse).not.toHaveBeenCalled();
  expect(firstFlatten).not.toHaveBeenCalled();
  expect(secondFlatten).not.toHaveBeenCalled();
  expect(heights.work.indexedReads).toBe(0);
  expect(renderTable).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
  expect(first.dom.isConnected).toBe(false);
  expect(second.dom.isConnected).toBe(false);
  expect(editor.view.contentDOM.querySelectorAll(".inkbook-text-table-cell-overlay")).toHaveLength(
    1,
  );
  await editor.flushChanges();
  await settle();
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange.mock.lastCall?.[0].source).toContain("| row 799 first | second |");
  expect(renderTable).toHaveBeenCalledTimes(2);
  expect(onError).not.toHaveBeenCalled();
});

it("enters the last cell by arrow with logarithmic row lookup and no full-field work", async () => {
  const { editor, settle, rows, runs, heights, renderTable, onChange, onError } = await mount();
  editor.view.dispatch({ selection: { anchor: source.indexOf("\n\nafter") + 1 } });
  // happy-dom has no text layout; native movement skips the replaced table source.
  vi.spyOn(editor.view, "moveByChar").mockReturnValue(EditorSelection.cursor(0));
  const wholeParse = vi.spyOn(markdownParser, "parseTextMarkdownSteps");
  const rowParse = vi.spyOn(markdownTables, "textTableBodySteps");
  const flatten = vi.spyOn(editor.view.state.doc, "toString");
  rows.work.indexedReads = 0;
  runs.work.indexedReads = 0;
  heights.work.indexedReads = 0;
  editor.inputView.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
  );
  await settle();
  expect(editor.inputView).not.toBe(editor.view);
  expect(editor.inputView.state.doc.toString()).toBe("value 999");
  expect(editor.inputView.state.selection.main.head).toBe(9);
  expect(editor.inputView.hasFocus).toBe(true);
  // One binary row lookup plus bounded boundary, active-cell and mounted-window metadata reads.
  expect(rows.work.indexedReads).toBeGreaterThan(0);
  expect(rows.work.indexedReads).toBeLessThanOrEqual(
    Math.ceil(Math.log2(rows.observed.length)) + 20,
  );
  expect(runs.work.indexedReads).toBeLessThanOrEqual(
    Math.ceil(Math.log2(runs.observed.length)) + 3,
  );
  expect(heights.work.indexedReads).toBe(0);
  expect(wholeParse).not.toHaveBeenCalled();
  expect(rowParse).not.toHaveBeenCalled();
  expect(flatten).not.toHaveBeenCalled();
  expect(renderTable).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it("resolves only the edited missing-cell row and reuses it for same-document navigation", async () => {
  const sparse = source
    .replace("| Name | Value |", "| Name | Value | Extra |")
    .replace("| --- | --- |", "| --- | --- | --- |");
  const { editor, settle, rows, renderTable, onError } = await mount(sparse);
  const first = activate(editor);
  await settle();
  const rowParse = vi.spyOn(markdownTables, "textTableBodySteps");
  const wholeParse = vi.spyOn(markdownParser, "parseTextMarkdownSteps");
  rows.work.indexedReads = 0;
  first.dispatch({ changes: { from: 7, insert: " first" } });
  tab(editor);
  expect(editor.inputView.state.doc.toString()).toBe("value 799");
  tab(editor);
  expect(editor.inputView.state.doc.toString()).toBe("");
  tab(editor, true);
  tab(editor);
  // One row resolution after the edit and one after adding its missing source separators.
  expect(rowParse).toHaveBeenCalledTimes(2);
  for (const [line] of rowParse.mock.calls) {
    expect(line.content).toContain("row 799 first");
    expect(line.content.length).toBeLessThanOrEqual(64);
  }
  // Constant metadata reads for four commands must never scan the 1,001-row descriptor.
  expect(rows.work.indexedReads).toBeLessThanOrEqual(128);
  expect(wholeParse).not.toHaveBeenCalled();
  expect(renderTable).toHaveBeenCalledOnce();
  editor.inputView.dispatch({ changes: { from: 0, insert: "third" } });
  await editor.flushChanges();
  await settle();
  expect(editor.source.split("\n").find((line) => line.startsWith("| row 799 first"))).toMatch(
    /\| value 799 \|\s*third\|$/u,
  );
  expect(onError).not.toHaveBeenCalled();
});
