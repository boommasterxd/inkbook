// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { StateEffect, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { TextTableCellView } from "../../../../../src/obsidian/text/editor/text-table-cell-view";
import { textTableCellPreviewSteps } from "../../../../../src/obsidian/text/editor/text-table-cell-preview";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { textElement } from "../../../domain/schema/fixtures";

const views: TextTableCellView[] = [];

function mount(overrides: Partial<ConstructorParameters<typeof TextTableCellView>[0]> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const frames = new ManualFrameScheduler();
  const onTransaction = vi.fn<(transaction: Transaction) => void>();
  const onNavigate = vi.fn(() => true);
  const onStyle = vi.fn(() => true);
  const onUndoRedo = vi.fn(() => true);
  const onFinish = vi.fn();
  const scheduler = {
    ...immediateWorkScheduler(),
    requestFrame: frames.requestFrame.bind(frames),
    cancelFrame: frames.cancelFrame.bind(frames),
  };
  const cell = new TextTableCellView({
    host,
    editor: {
      container: host,
      element: textElement(),
      scheduler,
      onChange: vi.fn(),
      onFinish,
    },
    sourceOffset: () => 10,
    originalPosition: (position) => position,
    onTransaction,
    onNavigate,
    onStyle,
    onUndoRedo,
    onHeight: vi.fn(),
    onFinish,
    ...overrides,
  });
  views.push(cell);
  const presentation = { style: textElement().style, width: 160, alignment: "left" as const };
  const key = (name: string, extra: KeyboardEventInit = {}) =>
    cell.view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra }),
    );
  return {
    cell,
    host,
    frames,
    scheduler,
    presentation,
    onTransaction,
    onNavigate,
    onStyle,
    onUndoRedo,
    key,
  };
}

function complete<Value>(steps: Generator<void, Value>): Value {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("relays native edits and selection while authoritative synchronization preserves the input view", () => {
  const t = mount();
  expect(t.cell.view.state.doc.toString()).toBe("");
  t.cell.sync("word", { anchor: 1, head: 3 }, t.presentation);
  expect(t.onTransaction).not.toHaveBeenCalled();
  t.cell.focus();
  t.onTransaction.mockClear();
  const dom = t.cell.view.contentDOM;
  t.cell.view.dispatch({ changes: { from: 1, to: 3, insert: "OR" } });
  expect(t.onTransaction).toHaveBeenCalledOnce();
  expect(t.onTransaction.mock.calls[0]![0].newDoc.toString()).toBe("wORd");
  t.cell.sync(
    "wORd",
    { anchor: 2, head: 2 },
    {
      ...t.presentation,
      style: { ...t.presentation.style, fontSize: 32 },
    },
  );
  expect(t.cell.view.contentDOM).toBe(dom);
  expect(t.cell.view.hasFocus).toBe(true);
  expect(t.cell.view.state.selection.main.head).toBe(2);
  t.cell.view.dispatch({ selection: { anchor: 4 } });
  expect(t.onTransaction).toHaveBeenCalledTimes(2);
  expect(t.cell.view.contentDOM.getAttribute("aria-multiline")).toBe("true");
});

it("keeps cursor movement inside wrapped content and delegates cell navigation and outer commands", () => {
  const t = mount();
  t.cell.sync("first\nlast", { anchor: 2, head: 2 }, t.presentation);
  vi.spyOn(t.cell.view, "moveToLineBoundary").mockReturnValueOnce(t.cell.view.state.selection.main);
  t.key("ArrowDown");
  expect(t.onNavigate).not.toHaveBeenCalled();
  t.cell.view.dispatch({ selection: { anchor: 0 } });
  t.key("ArrowLeft");
  t.key("Tab", { shiftKey: true });
  t.key("Enter");
  t.key("Escape");
  t.key("b", { ctrlKey: true });
  t.key("i", { ctrlKey: true });
  t.key("z", { ctrlKey: true });
  t.key("y", { ctrlKey: true });
  expect(t.onNavigate.mock.calls).toEqual([["backward"], ["previous"], ["enter"], ["escape"]]);
  expect(t.onStyle.mock.calls).toEqual([
    ["bold", undefined],
    ["italic", undefined],
  ]);
  expect(t.onUndoRedo.mock.calls).toEqual([[false], [true]]);
});

it("preserves the synchronized caret until a pointer belongs to a measured cell", () => {
  const t = mount();
  t.cell.sync("word", { anchor: 0, head: 0 }, t.presentation);
  const position = vi.spyOn(t.cell.view, "posAtCoords").mockReturnValue(2);
  t.cell.focus({ x: 0, y: 0 });
  expect(position).not.toHaveBeenCalled();
  expect(t.cell.view.state.selection.main.head).toBe(0);
  vi.spyOn(t.host, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 160, 40));
  t.cell.focus({ x: 15, y: 25 });
  expect(position).toHaveBeenCalledExactlyOnceWith({ x: 15, y: 25 });
  expect(t.cell.view.state.selection.main.head).toBe(2);
});

it("refreshes authoritative cell source before keyboard handling and native input", () => {
  const refresh = vi.fn(() => {
    t.cell.sync("current", { anchor: 7, head: 7 }, t.presentation);
  });
  const t = mount({ onBeforeInput: refresh });
  t.cell.sync("old", { anchor: 3, head: 3 }, t.presentation);
  t.onNavigate.mockImplementation(() => {
    expect(t.cell.view.state.doc.toString()).toBe("current");
    return true;
  });
  t.key("Tab");
  t.cell.view.contentDOM.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(t.onNavigate).toHaveBeenCalledExactlyOnceWith("next");
});

it("coalesces recursive synchronization until the current native update has completed", () => {
  const t = mount();
  t.cell.sync("old", { anchor: 0, head: 0 }, t.presentation);
  t.cell.view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.state.doc.toString() !== "typed") return;
        t.cell.sync("outdated", { anchor: 0, head: 0 }, t.presentation);
        t.cell.sync("latest", { anchor: 6, head: 6 }, t.presentation);
      }),
    ),
  });
  t.cell.view.dispatch({ changes: { from: 0, to: 3, insert: "typed" } });
  expect(t.cell.view.state.doc.toString()).toBe("typed");
  for (let frame = 0; frame < 10 && t.frames.pendingCount; frame += 1) t.frames.runNext();
  expect(t.cell.view.state.doc.toString()).toBe("latest");
  expect(t.cell.view.state.selection.main.head).toBe(6);
  expect(t.frames.pendingCount).toBe(0);
});

it("isolates selection feedback during sync and native updates and releases its document listener", () => {
  const t = mount();
  t.cell.sync("old", { anchor: 0, head: 0 }, t.presentation);
  t.cell.focus();
  const selectionChanged = vi.fn();
  document.addEventListener("selectionchange", selectionChanged);
  try {
    t.cell.sync("**changed**", { anchor: 2, head: 9 }, t.presentation);
    expect(selectionChanged).not.toHaveBeenCalled();
    t.cell.view.dispatch({ selection: { anchor: 0, head: 11 } });
    expect(t.cell.view.state.selection.main).toMatchObject({ anchor: 0, head: 11 });
    expect(t.onTransaction).toHaveBeenCalledOnce();
    expect(t.onTransaction.mock.lastCall?.[0].newSelection.main).toMatchObject({
      anchor: 0,
      head: 11,
    });
    expect(selectionChanged).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("selectionchange"));
    expect(selectionChanged).toHaveBeenCalledOnce();
    t.cell.dispose();
    document.dispatchEvent(new Event("selectionchange"));
    expect(selectionChanged).toHaveBeenCalledTimes(2);
  } finally {
    document.removeEventListener("selectionchange", selectionChanged);
  }
});

it("projects canonical inline spans and math into one cell without parsing pending source", () => {
  const parentSource = "| **head** | B |\n| --- | --- |\n| *word* $x$ | other |";
  const style = textElement().style;
  const parsed = parseTextMarkdown(parentSource, { style });
  const block = parsed.blocks[0]!;
  const cell = block.table!.rows[1]!.cells[0]!;
  const source = parentSource.slice(cell.contentStart, cell.contentEnd);
  const presentation = {
    style,
    width: 120,
    alignment: "center" as const,
    block,
    cell,
    parentSource,
  };
  const preview = complete(textTableCellPreviewSteps(source, presentation));
  const paragraph = preview.document.blocks[0]!;
  expect(paragraph.kind).toBe("paragraph");
  expect(paragraph.alignment).toBe("center");
  expect(paragraph.runs.map((run) => run.text)).toEqual(["word", " ", "x"]);
  expect(paragraph.spans[0]).toMatchObject({ start: 0, end: 6, contentStart: 1, contentEnd: 5 });
  const math = paragraph.runs.find((run) => run.kind === "math")!;
  expect(source.slice(math.start, math.end)).toBe("$x$");
  expect(preview.mathSyntax.get(math)?.values).not.toHaveLength(0);
  const pending = complete(textTableCellPreviewSteps("changed", presentation));
  expect(pending.document.blocks[0]!.runs).toEqual([]);
});

it("bounds active-cell projection to indexed visits and reuses it for caret-only synchronization", () => {
  const parentSource = "| A | B |\n| --- | --- |\n" + "| **value** | next |\n".repeat(1_024);
  const t = mount();
  const block = parseTextMarkdown(parentSource, { style: t.presentation.style }).blocks[0]!;
  const cell = block.table!.rows[1_024]!.cells[0]!;
  const source = parentSource.slice(cell.contentStart, cell.contentEnd);
  let visits = 0;
  for (const run of [...block.runs, ...block.spans]) {
    const start = run.start;
    Object.defineProperty(run, "start", {
      get: () => {
        visits += 1;
        return start;
      },
    });
  }
  const presentation = { ...t.presentation, block, cell, parentSource };
  t.cell.sync(source, { anchor: source.length, head: source.length }, presentation);
  expect(visits).toBeGreaterThan(0);
  expect(visits).toBeLessThan(40);
  const preparedVisits = visits;
  t.cell.sync(
    source,
    { anchor: 3, head: 3 },
    {
      ...presentation,
      style: { ...presentation.style },
    },
  );
  expect(visits).toBe(preparedVisits);
});

it("cancels stale cooperative previews before publishing a different active cell", async () => {
  const t = mount();
  const parentSource = "| A | B |\n| --- | --- |\n| **first** | *last* tail |";
  const block = parseTextMarkdown(parentSource, { style: t.presentation.style }).blocks[0]!;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const checkpoint = vi.spyOn(t.scheduler, "checkpoint").mockReturnValue(waiting);
  for (const cell of block.table!.rows[1]!.cells) {
    const source = parentSource.slice(cell.contentStart, cell.contentEnd);
    t.cell.sync(
      source,
      { anchor: source.length, head: source.length },
      {
        ...t.presentation,
        block,
        cell,
        parentSource,
      },
    );
  }
  checkpoint.mockReturnValue(undefined);
  release!();
  await waiting;
  expect(t.cell.view.state.doc.toString()).toBe("*last* tail");
  expect(t.cell.view.contentDOM.textContent).toBe("last tail");
  expect(t.onTransaction).not.toHaveBeenCalled();
});
