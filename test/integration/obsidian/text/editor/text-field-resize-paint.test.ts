// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import {
  TextFieldEditor,
  type TextFieldEditorOptions,
} from "../../../../../src/obsidian/text/editor/text-field-editor";
import type { TextTableRenderResult } from "../../../../../src/obsidian/text/editor/text-field-editor-types";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import { setTextTableSource } from "../../../../../src/obsidian/text/editor/text-table-mode";
import { appendOwnedIframe } from "../../../../fixtures/obsidian/owned-iframe";

const source = "$x^2=\\frac{1}{2}$\n\n| A | B |\n| --- | --- |\n| one | two |\n\nfooter";
const editors: TextFieldEditor[] = [];

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function paint(label: string) {
  const node = document.createElement("span");
  node.textContent = label;
  return node;
}

function mount(ownerDocument = document) {
  const frames = new ManualFrameScheduler();
  const scheduler = workSchedulerFromFrames(frames);
  const container = ownerDocument.createElement("div");
  ownerDocument.body.append(container);
  const element = { ...textElement(), source };
  const math = deferred<HTMLElement>();
  const table = deferred<TextTableRenderResult>();
  let delay = false;
  const signals: AbortSignal[] = [];
  const renderMath = vi.fn<NonNullable<TextFieldEditorOptions["renderMath"]>>(
    async (_latex, _display, signal, context) => {
      signals.push(signal);
      return delay ? math.promise : paint(`Math ${context?.availableWidth}`);
    },
  );
  const renderTable = vi.fn<NonNullable<TextFieldEditorOptions["renderTable"]>>(
    async (_block, _signal, context) =>
      delay
        ? table.promise
        : { node: paint(`Table ${context.availableWidth}`), rowHeights: [20, 30] },
  );
  const onError = vi.fn();
  const editor = new TextFieldEditor({
    container,
    element,
    scheduler,
    renderMath,
    renderTable,
    onChange: vi.fn(),
    onFinish: vi.fn(),
    onError,
  });
  editors.push(editor);
  editor.view.dispatch({ selection: { anchor: source.length } });
  const flush = () => {
    while (frames.pendingCount) frames.runNext();
  };
  flush();
  return {
    editor,
    scheduler,
    element,
    math,
    table,
    renderMath,
    renderTable,
    signals,
    onError,
    flush,
    delay: () => {
      delay = true;
    },
  };
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  document.body.replaceChildren();
});

async function beginDelayedResize(t: ReturnType<typeof mount>) {
  t.delay();
  const resized = { ...t.element, width: 240 };
  const preparation = t.editor.prepareGeometry(resized, new AbortController().signal);
  await vi.waitFor(() => {
    t.flush();
    expect(t.renderMath).toHaveBeenCalledTimes(2);
  });
  return { resized, preparation };
}

it("publishes the prepared native background with its new box before queued iframe measurements", async () => {
  const inner = appendOwnedIframe();
  const t = mount(inner.document);
  await vi.waitFor(() => expect(t.editor.view.contentDOM.textContent).toContain("Table 100"));
  const backgroundColor = { type: "rgba", value: "#FF0000FF" } as const;
  const initial = { ...t.element, backgroundColor, backgroundOpacity: 0.7 };
  t.editor.updateElement(initial);
  t.editor.measureContentHeight();
  const base = t.editor.view.dom.querySelector(".inkbook-text-editor-background > path")!;
  const oldPath = base.getAttribute("d");
  const resized = { ...initial, width: 240 };
  await t.editor.prepareGeometry(resized, new AbortController().signal);
  // The admitted native publication must remain atomic even when no cooperative CPU slice remains.
  const checkpoint = vi
    .spyOn(t.scheduler, "checkpoint")
    .mockImplementation(() => new Promise(() => {}));
  const measures = vi.spyOn(t.editor.view, "requestMeasure");
  t.editor.updateElement(resized);
  t.editor.measureContentHeight();
  expect(measures).toHaveBeenCalled();
  expect(base.getAttribute("d")).not.toBe(oldPath);
  expect(base.getAttribute("d")).toContain("240");
  expect(t.editor.view.dom.querySelector("mask")?.getAttribute("width")).toBe("240");
  expect(checkpoint).not.toHaveBeenCalled();
  expect(t.onError).not.toHaveBeenCalled();
  t.editor.dispose();
  inner.frame.remove();
});

it("prepares math and table paint before publishing resized bounds without replacing native source or caret", async () => {
  const t = mount();
  await vi.waitFor(() => expect(t.editor.view.contentDOM.textContent).toContain("Table 100"));
  const content = t.editor.view.contentDOM;
  const native = t.editor.view.state.doc;
  const selection = t.editor.view.state.selection;
  const mathNode = content.querySelector(".inkbook-text-math-widget");
  const tableNode = content.querySelector(".inkbook-text-table-widget");
  const { resized, preparation } = await beginDelayedResize(t);
  expect(mathNode?.textContent).toBe("Math 100");
  t.math.resolve(paint("Math 240"));
  await vi.waitFor(() => expect(t.renderTable).toHaveBeenCalledTimes(2));
  expect(tableNode?.textContent).toContain("Table 100");
  t.table.resolve({ node: paint("Table 240"), rowHeights: [25, 40] });
  await preparation;
  expect(mathNode?.textContent).toBe("Math 100");
  t.editor.updateElement(resized);
  expect(content.querySelector(".inkbook-text-math-widget")).toBe(mathNode);
  expect(content.querySelector(".inkbook-text-table-widget")).toBe(tableNode);
  expect(mathNode?.textContent).toBe("Math 240");
  expect(tableNode?.textContent).toContain("Table 240");
  expect(content.querySelector("[aria-busy]")).toBeNull();
  expect(t.renderMath).toHaveBeenCalledTimes(2);
  expect(t.renderTable).toHaveBeenCalledTimes(2);
  expect(t.editor.view.state.doc).toBe(native);
  expect(t.editor.view.state.selection.eq(selection)).toBe(true);
  mathNode?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  expect(t.editor.selectionStart).toBe(1);
  expect(content.querySelector(".inkbook-text-math-widget")).toBeNull();
  expect(t.editor.source).toBe(source);
  expect(t.onError).not.toHaveBeenCalled();
});

it("keeps deliberately revealed math and table source selected through prepared reflow", async () => {
  const t = mount();
  await vi.waitFor(() => expect(t.editor.view.contentDOM.textContent).toContain("Table 100"));
  t.editor.view.dispatch({ selection: { anchor: 0, head: source.length } });
  const selection = t.editor.view.state.selection;
  const native = t.editor.view.state.doc;
  const beforeMath = t.renderMath.mock.calls.length;
  const beforeTables = t.renderTable.mock.calls.length;
  const resized = { ...t.element, width: 240 };
  await t.editor.prepareGeometry(resized, new AbortController().signal);
  t.editor.updateElement(resized);
  expect(
    t.editor.view.contentDOM.querySelector(".inkbook-text-math-widget,.inkbook-text-table-widget"),
  ).toBeNull();
  expect(t.editor.view.state.doc).toBe(native);
  expect(t.editor.view.state.selection.eq(selection)).toBe(true);
  expect(t.editor.source).toBe(source);
  expect(t.renderMath).toHaveBeenCalledTimes(beforeMath);
  expect(t.renderTable).toHaveBeenCalledTimes(beforeTables);
});

it("cancels owned pending geometry paint when its editor is disposed and ignores its late result", async () => {
  const t = mount();
  await vi.waitFor(() => expect(t.editor.view.contentDOM.textContent).toContain("Table 100"));
  const { preparation } = await beginDelayedResize(t);
  const mathNode = t.editor.view.contentDOM.querySelector(".inkbook-text-math-widget");
  t.editor.dispose();
  expect(t.signals[t.signals.length - 1]?.aborted).toBe(true);
  t.math.resolve(paint("Late geometry"));
  await expect(preparation).rejects.toThrow();
  expect(mathNode?.textContent).toBe("Math 100");
  expect(t.renderTable).toHaveBeenCalledOnce();
  expect(t.onError).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves table source mode %s changed during asynchronous geometry preparation",
  async (sourceMode) => {
    const t = mount();
    await vi.waitFor(() => expect(t.editor.view.contentDOM.textContent).toContain("Table 100"));
    const block = { start: source.indexOf("| A"), end: source.indexOf("\n\nfooter") };
    t.editor.view.dispatch({
      selection: { anchor: block.start + 2 },
      effects: setTextTableSource.of({ ...block, source: !sourceMode }),
    });
    const selection = t.editor.view.state.selection;
    const native = t.editor.view.state.doc;
    const { resized, preparation } = await beginDelayedResize(t);
    t.editor.view.dispatch({ effects: setTextTableSource.of({ ...block, source: sourceMode }) });
    expect(t.editor.view.state.doc).toBe(native);
    expect(t.editor.view.state.selection.eq(selection)).toBe(true);
    t.math.resolve(paint("Math 240"));
    t.table.resolve({ node: paint("Table 240"), rowHeights: [25, 40] });
    await preparation;
    t.editor.updateElement(resized);
    expect(
      t.editor.view.contentDOM.querySelector(".inkbook-text-table-source-control") !== null,
    ).toBe(sourceMode);
    expect(t.editor.view.contentDOM.querySelector(".inkbook-text-table-widget") !== null).toBe(
      !sourceMode,
    );
    expect(t.editor.view.state.doc).toBe(native);
    expect(t.editor.view.state.selection.eq(selection)).toBe(true);
    expect(t.onError).not.toHaveBeenCalled();
  },
);
