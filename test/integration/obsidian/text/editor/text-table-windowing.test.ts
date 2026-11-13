// @vitest-environment happy-dom

import type { EditorView } from "@codemirror/view";
import { Text } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextFieldEditor } from "../../../../../src/obsidian/text/editor/text-field-editor";
import type {
  TextMathWidgetPorts,
  TextTableMount,
  TextTableRowRange,
} from "../../../../../src/obsidian/text/editor/text-field-editor-types";
import { TextTableViewport } from "../../../../../src/obsidian/text/editor/text-table-viewport";
import { TextTableWidget } from "../../../../../src/obsidian/text/editor/text-table-widget";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import { assertAccessibleSemantics } from "../../../../fixtures/accessibility";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import {
  captureTextTableMeasurements,
  mountTextTableViewport,
  type TextTableMeasurement,
} from "../../../../fixtures/obsidian/text-table-viewport";

const editors: TextFieldEditor[] = [];
const source = `| Name | Value |\n| --- | --- |\n${Array.from(
  { length: 1_000 },
  (_, index) => `| row ${index} | value ${index} |`,
).join("\n")}\n\nafter`;

async function microtasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function mount() {
  const container = mountTextTableViewport();
  const frames = new ManualFrameScheduler();
  const paint = document.createElement("div");
  let beforePaint: ((signal: AbortSignal) => Promise<void>) | undefined;
  const renderRows = vi.fn(async (range: TextTableRowRange, signal: AbortSignal) => {
    await beforePaint?.(signal);
    if (signal.aborted) return;
    paint.replaceChildren(
      ...Array.from({ length: range.to - range.from }, (_, index) => {
        const row = document.createElement("span");
        row.textContent = `Paint ${range.from + index}`;
        return row;
      }),
    );
  });
  const onError = vi.fn();
  const editor = new TextFieldEditor({
    container,
    element: { ...textElement(), source, width: 200 },
    scheduler: workSchedulerFromFrames(frames),
    renderTable: async () => ({
      node: paint,
      rowHeights: Array<number>(1_001).fill(20),
      renderRows,
    }),
    onChange: vi.fn(),
    onFinish: vi.fn(),
    onError,
  });
  editors.push(editor);
  editor.view.dispatch({ selection: { anchor: source.length } });
  // Prepare source once; native row measurements below own the subsequent viewport work.
  frames.runNext();
  const { pending, widget } = captureTextTableMeasurements(editor.view);
  let scroll = 0;
  vi.spyOn(widget, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, -scroll, 200, 20_020),
  );
  const measure = async () => {
    await microtasks();
    const request = pending
      .splice(0)
      .reverse()
      .find((candidate) => candidate.key instanceof TextTableViewport);
    if (!request) throw new Error("Missing native table viewport measurement.");
    request.write?.(request.read(editor.view), editor.view);
    await microtasks();
    await microtasks();
  };
  return {
    editor,
    widget,
    paint,
    renderRows,
    onError,
    measure,
    scroll: (value: number) => {
      scroll = value;
      editor.requestViewportMeasure();
    },
    delay: (callback: (signal: AbortSignal) => Promise<void>) => {
      beforePaint = callback;
    },
  };
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("prepared table viewport publication", () => {
  it("keeps the previous table visible until the resized visible rows and source controls are complete", async () => {
    const container = mountTextTableViewport();
    const view = {
      dom: container,
      contentDOM: container,
      scaleX: 1,
      scaleY: 1,
      requestMeasure: vi.fn(),
    } as unknown as EditorView;
    const value = "| A | B |\n| --- | --- |\n| one | two |";
    const style = textElement().style;
    const block = parseTextMarkdown(value, { style }).blocks[0]!;
    let release: (() => void) | undefined;
    let delay = false;
    const renders = vi.fn(
      async (_block, signal: AbortSignal, context: { availableWidth: number }) => {
        const paint = document.createElement("span");
        return {
          node: paint,
          rowHeights: [20, 30],
          renderRows: async () => {
            if (delay)
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            if (!signal.aborted) paint.textContent = `Complete rows ${context.availableWidth}`;
          },
        };
      },
    );
    const ports: TextMathWidgetPorts = {
      scheduler: createTestWorkScheduler(),
      render: undefined,
      renderTable: renders,
      onError: vi.fn(),
      activate: vi.fn(),
      width: () => 200,
      style: () => style,
    };
    const initial = new TextTableWidget(block, Text.of(value.split("\n")), 200, ports);
    const node = initial.toDOM(view);
    container.append(node);
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 50));
    await vi.waitFor(() => expect(node.textContent).toContain("Complete rows 200"));
    const previousControls = node.querySelector("table");
    delay = true;
    const replacement = new TextTableWidget(block, initial.source, 300, ports);
    const preparation = replacement.prepare(view, new AbortController().signal);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(node.textContent).toContain("Complete rows 200");
    expect(node.querySelector("table")).toBe(previousControls);
    release?.();
    await preparation;
    expect(node.textContent).toContain("Complete rows 200");
    replacement.updateDOM(node, view);
    expect(node.textContent).toContain("Complete rows 300");
    expect(node.querySelectorAll("button[data-inkbook-source]")).toHaveLength(4);
    expect(node.getAttribute("aria-busy")).toBeNull();
    expect(renders).toHaveBeenCalledTimes(2);
    replacement.destroy(node);
  });
});

describe("retained table widget lifetime", () => {
  it("retains the cell editor owner while replacing prepared source and cancels retired generations", async () => {
    const view = {
      dom: document.createElement("div"),
      requestMeasure: vi.fn(),
    } as unknown as EditorView;
    const mounts: TextTableMount[] = [];
    const signals: AbortSignal[] = [];
    const overlay = document.createElement("div");
    overlay.textContent = "Retained cell editor";
    const activate = vi.fn();
    const unmounted = vi.fn();
    const style = textElement().style;
    const ports: TextMathWidgetPorts = {
      render: undefined,
      renderTable: async (_block, signal) => {
        signals.push(signal);
        return { node: document.createElement("span"), rowHeights: [20, 30] };
      },
      onError: vi.fn(),
      activate: vi.fn(),
      width: () => 200,
      style: () => style,
      tableEditing: {
        mounted: (context) => {
          mounts.push(context);
          if (!overlay.parentElement) context.node.append(overlay);
        },
        unmounted,
        activate,
        focusedRow: () => 1,
      },
    };
    const makeWidget = (value: string, width: number) => {
      const block = parseTextMarkdown(value, { style }).blocks.find(
        (item) => item.kind === "table",
      )!;
      return new TextTableWidget(block, Text.of(value.split("\n")), width, ports);
    };
    const before = "| A | B |\n| --- | --- |\n| old | value |";
    const initial = makeWidget(before, 200);
    const node = initial.toDOM(view);
    document.body.append(node);
    await microtasks();
    const after = before.replace("old", "updated");
    const replacement = makeWidget(after, 300);
    expect(replacement.updateDOM(node, view)).toBe(true);
    expect(signals[0]?.aborted).toBe(false);
    expect(mounts[0]?.signal.aborted).toBe(false);
    await microtasks();
    expect(signals[0]?.aborted).toBe(true);
    expect(mounts).toHaveLength(2);
    expect(mounts[1]?.signal).toBe(mounts[0]?.signal);
    expect(mounts[1]?.source.toString()).toBe(after);
    expect(mounts[1]?.width).toBe(300);
    expect(mounts[1]?.rowTop(1)).toBe(20);
    expect(overlay.parentElement).toBe(node);
    const cell = node.querySelector<HTMLButtonElement>(
      'button[data-inkbook-table-row="1"][data-inkbook-table-column="1"]',
    )!;
    cell.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: 12, clientY: 34 }),
    );
    expect(activate).toHaveBeenCalledExactlyOnceWith(node, 1, 1, { x: 12, y: 34 });
    replacement.destroy(node);
    expect(mounts[0]?.signal.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
    expect(unmounted).toHaveBeenCalledExactlyOnceWith(node);
  });
});

describe("windowed table source controls and canonical paint", () => {
  it("preserves a focused source control independently of a distant visible row window", async () => {
    const { widget, onError, measure, scroll } = mount();
    await measure();
    widget.querySelector<HTMLElement>('tr[aria-rowindex="4"] button')?.focus();
    expect(document.activeElement?.textContent).toBe("row 2");
    scroll(16_000);
    await measure();
    expect(document.activeElement?.textContent).toBe("row 2");
    expect(widget.querySelectorAll("button[data-inkbook-table-column]").length).toBeLessThanOrEqual(
      24,
    );
    expect(
      widget.ownerDocument.body.querySelectorAll(".inkbook-text-table-controls button"),
    ).toHaveLength(3);
    expect(widget.querySelector('tr[aria-rowindex="801"] button')?.textContent).toBe("row 799");
    expect(onError).not.toHaveBeenCalled();
  });

  it("mounts bounded initial and far-scrolled rows with complete scroll extent and source offsets", async () => {
    const { editor, widget, paint, renderRows, onError, measure, scroll } = mount();
    await measure();
    expect(paint.isConnected).toBe(true);
    expect(paint.childElementCount).toBeLessThanOrEqual(10);
    expect(widget.querySelectorAll("button[data-inkbook-table-column]").length).toBeLessThanOrEqual(
      20,
    );
    expect(
      widget.ownerDocument.body.querySelectorAll(".inkbook-text-table-controls button"),
    ).toHaveLength(3);
    expect(widget.style.height).toBe("20020px");
    expect(widget.querySelector("table")?.getAttribute("aria-rowcount")).toBe("1001");
    scroll(16_000);
    await measure();
    const range = renderRows.mock.lastCall?.[0];
    expect(range?.from).toBeGreaterThanOrEqual(798);
    expect(range?.to).toBeLessThanOrEqual(808);
    expect(paint.childElementCount).toBeLessThanOrEqual(10);
    expect(widget.querySelectorAll("button[data-inkbook-table-column]").length).toBeLessThanOrEqual(
      22,
    );
    await assertAccessibleSemantics(widget, ["button-name"]);
    const cell = widget.querySelector<HTMLElement>('tr[aria-rowindex="801"] button');
    expect(cell?.textContent).toBe("row 799");
    cell?.click();
    expect(editor.selectionStart).toBe(source.indexOf("row 799"));
    expect(editor.source).toBe(source);
    expect(onError).not.toHaveBeenCalled();
  });

  it("retires offscreen rows, avoids identical redraws and cancels stale paint on viewport changes or disposal", async () => {
    const { editor, widget, paint, renderRows, onError, measure, scroll, delay } = mount();
    await measure();
    scroll(0);
    await measure();
    expect(renderRows).toHaveBeenCalledOnce();
    scroll(30_000);
    await measure();
    expect(paint.childElementCount).toBe(0);
    expect(widget.querySelectorAll("button[data-inkbook-table-column]")).toHaveLength(0);
    expect(
      widget.ownerDocument.body.querySelectorAll(".inkbook-text-table-controls button"),
    ).toHaveLength(3);
    const signals: AbortSignal[] = [];
    const resolve: (() => void)[] = [];
    delay((signal) => {
      signals.push(signal);
      return new Promise((finish) => {
        resolve.push(finish);
      });
    });
    scroll(100);
    await measure();
    scroll(500);
    await measure();
    expect(signals[0]?.aborted).toBe(true);
    resolve[0]?.();
    await microtasks();
    expect(paint.childElementCount).toBe(0);
    editor.dispose();
    expect(signals[1]?.aborted).toBe(true);
    resolve[1]?.();
    await microtasks();
    expect(paint.childElementCount).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("temporary table row window geometry", () => {
  it("reuses offsets until row geometry changes and retains an offscreen active cell", async () => {
    const clip = document.createElement("div");
    clip.className = "inkbook-text-editor-viewport";
    const node = document.createElement("div");
    clip.append(node);
    document.body.append(clip);
    vi.spyOn(clip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
    vi.spyOn(node, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, 200, Number.parseFloat(node.style.height)),
    );
    const pending: TextTableMeasurement[] = [];
    const view = {
      dom: clip,
      scaleX: 1,
      scaleY: 1,
      requestMeasure: (request: TextTableMeasurement | undefined) => {
        if (request) pending.push(request);
      },
    } as unknown as EditorView;
    let geometryVersion = 0;
    let editedHeight = 20;
    const rowHeight = vi.fn((index: number) => (index === 5 ? editedHeight : 20));
    const abort = new AbortController();
    const block = parseTextMarkdown(source, { style: textElement().style }).blocks.find(
      (item) => item.kind === "table",
    )!;
    const viewport = new TextTableViewport({
      view,
      node,
      block,
      source: Text.of(source.split("\n")),
      width: 200,
      label: "Edit cell",
      scheduler: createTestWorkScheduler(),
      signal: abort.signal,
      settled: vi.fn(),
      onError: vi.fn(),
      focusedRow: () => 800,
      result: {
        node: document.createElement("span"),
        rowHeights: Array<number>(1_001).fill(20),
        rowHeight,
        get geometryVersion() {
          return geometryVersion;
        },
        renderRows: vi.fn(async () => {}),
      },
    });
    const publish = async () => {
      const request = pending
        .splice(0)
        .reverse()
        .find((item) => item.key === viewport)!;
      request.write?.(request.read(view), view);
      await microtasks();
    };
    await viewport.start();
    await publish();
    expect(viewport.rowTop(800)).toBe(16_000);
    expect(rowHeight).toHaveBeenCalledTimes(1_001);
    expect(node.querySelectorAll("button").length).toBeLessThanOrEqual(22);
    expect(node.querySelector('tr[aria-rowindex="801"] button')?.textContent).toBe("row 799");
    viewport.refresh();
    await publish();
    expect(rowHeight).toHaveBeenCalledTimes(1_001);
    editedHeight = 80;
    geometryVersion += 1;
    viewport.refresh();
    await microtasks();
    await publish();
    expect(node.style.height).toBe("20080px");
    expect(viewport.rowTop(5)).toBe(100);
    expect(viewport.rowTop(800)).toBe(16_060);
    expect(node.querySelector<HTMLElement>('tr[aria-rowindex="6"]')?.style.height).toBe("80px");
    expect(rowHeight).toHaveBeenCalledTimes(2_002);
    abort.abort();
    viewport.refresh();
    expect(rowHeight).toHaveBeenCalledTimes(2_002);
  });
});
