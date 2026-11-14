// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { Localization } from "../../../../../src/domain/localization";
import {
  activeTextLayout,
  openTextSessionRange,
  textSessionFontResources,
  useActiveTextSessions,
} from "../../../../fixtures/obsidian/active-text-session";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";
import { ObsidianTextMathRenderer } from "../../../../../src/obsidian/text/math-renderer";
import { PortableMathRenderer } from "../../../../../src/obsidian/text/portable-math-renderer";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { textToolbarIcon } from "../../../../../src/obsidian/embeds/active-editor/text-toolbar-icon";

const mount = useActiveTextSessions();

it("canonicalizes fractional slider styles before source ranges enter prepared save and history", async () => {
  const state = mount();
  await state.session.edit(state.element.id);
  state.input().contentDOM.blur();
  state.input().dispatch({ selection: { anchor: 1, head: 4 } });
  expect(state.session.applyStyle("text-font-size", 0.0001)).toBe(false);
  expect(state.session.applyStyle("text-font-size", 4096.1)).toBe(false);
  expect(state.session.applyStyle("text-font-size", 35.123456789)).toBe(true);
  expect(state.session.applyStyle("opacity", 0.123456789)).toBe(true);
  expect(state.session.applyStyle("text-background-opacity", 0.43219876)).toBe(true);
  await expect(state.session.finish()).resolves.toBe(true);
  const saved = state.model.store.get(state.element.id)!.element as TextElementV2;
  expect(saved.ranges).toEqual([
    {
      start: 1,
      end: 4,
      style: {
        fontSize: 35.123,
        opacity: 0.1235,
        backgroundOpacity: 0.4322,
      },
    },
  ]);
  expect(saved.style).toEqual(state.element.style);
  await expect(state.history.undoAsync()).resolves.toBe(true);
  await expect(state.history.redoAsync()).resolves.toBe(true);
  expect(state.model.store.get(saved.id)?.element).toEqual(saved);
  expect(state.error).not.toHaveBeenCalled();
  expect(state.operations()).toBe(0);
});

it("shares each native caret and mixed-selection format with the current toolbar and Style controls", async () => {
  const source = "Plain **bold** *italic* ~~strike~~ under plain.";
  const under = source.indexOf("under");
  const state = mount(
    activeTextLayout({
      ...textElement(),
      source,
      ranges: [{ start: under, end: under + 5, style: { underline: true } }],
    }),
  );
  await state.session.edit(state.element.id);
  const input = state.input();
  input.contentDOM.blur();
  const marks = ["bold", "italic", "underline", "strikethrough"] as const;
  for (const [word, active] of [
    ["bold", "bold"],
    ["italic", "italic"],
    ["under", "underline"],
    ["strike", "strikethrough"],
    ["Plain", null],
  ] as const) {
    input.dispatch({ selection: { anchor: source.indexOf(word) + 2 } });
    const summary = state.session.styleSummary()!;
    expect(textToolbarIcon(summary).text).toEqual(
      Object.fromEntries(marks.map((mark) => [mark, mark === active])),
    );
    const controls = state.session.controls(new Localization().t)!;
    for (const mark of marks)
      expect(controls.find(({ id }) => id === `text-${mark}`)).toMatchObject({
        checked: mark === active,
        mixed: false,
      });
  }
  input.dispatch({ selection: { anchor: 0, head: under + 5 } });
  expect(textToolbarIcon(state.session.styleSummary()!).text).toEqual(
    Object.fromEntries(marks.map((mark) => [mark, null])),
  );
  for (const mark of marks)
    expect(
      state.session.controls(new Localization().t)!.find(({ id }) => id === `text-${mark}`),
    ).toMatchObject({ checked: false, mixed: true });
  input.dispatch({ selection: { anchor: 2 } });
  state.session.applyStyle("text-underline", true);
  expect(state.session.styleSummary()!.style.underline).toBe(true);
  input.dispatch({ selection: { anchor: source.indexOf("italic") + 2 } });
  expect(textToolbarIcon(state.session.styleSummary()!).text).toMatchObject({
    italic: true,
    underline: false,
  });
  expect(state.history.commandCount).toBe(0);
  expect(state.model.store.get(state.element.id)?.element).toMatchObject({ source });
  expect(state.error).not.toHaveBeenCalled();
});

it("shares pending caret formatting between the Style controls and toolbar preview", async () => {
  const state = mount();
  await state.session.edit(state.element.id);
  state.input().dispatch({ selection: { anchor: 1 } });
  expect(state.session.applyStyle("color", "#EF4444FF")).toBe(true);
  expect(state.session.applyStyle("text-bold", true)).toBe(true);
  const summary = state.session.styleSummary()!;
  expect(textToolbarIcon(summary)).toMatchObject({
    outlineColor: { type: "rgba", value: "#EF4444FF" },
    text: { bold: true },
  });
  const controls = state.session.controls(new Localization().t)!;
  expect(controls.find(({ id }) => id === "color")).toMatchObject({ value: "#EF4444FF" });
  expect(controls.find(({ id }) => id === "text-bold")).toMatchObject({ checked: true });
  state.input().dispatch({ selection: { anchor: 0 } });
  expect(state.session.styleSummary()?.style.color).toEqual(state.element.style.color);
  await expect(state.session.finish()).resolves.toBe(true);
  expect(state.operations()).toBe(0);
  expect(state.error).not.toHaveBeenCalled();
});

it("retains the current paragraph alignment at its line end before a newline", async () => {
  const state = mount({
    ...textElement(),
    source: "First\n\nSecond",
    paragraphs: [
      { start: 0, alignment: "center" },
      { start: 7, alignment: "left" },
    ],
  });
  await state.session.edit(state.element.id);
  const input = state.input();
  input.contentDOM.blur();
  input.dispatch({ selection: { anchor: 5 } });
  expect(state.session.styleSummary()?.alignment).toBe("center");
  expect(state.session.applyStyle("text-alignment", "right")).toBe(true);
  await state.session.flush();
  expect(state.session.styleSummary()?.alignment).toBe("right");
  input.dispatch({ selection: { anchor: 9 } });
  expect(state.session.styleSummary()?.alignment).toBe("left");
  expect(state.error).not.toHaveBeenCalled();
});

function pausePreparation(
  state: ReturnType<typeof mount>,
  respectCancellation = false,
): () => void {
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.prepare.mockImplementationOnce(async (element, signal) => {
    await gate;
    if (respectCancellation) signal.throwIfAborted();
    return activeTextLayout(element);
  });
  return () => release();
}

describe("active text document session", () => {
  it("creates through the prepared document mutation and retains shared undo/redo", async () => {
    const state = mount();
    const release = pausePreparation(state);
    const creation = state.session.create({ x: 20, y: 40, width: 240 }, "Pasted text", false);
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
    expect(state.session.active).toBe(true);
    release();
    await expect(creation).resolves.toBe(true);
    expect(state.history.commandCount).toBe(1);
    expect(state.model.store.size).toBe(2);
    expect(state.session.active).toBe(false);
    await expect(state.history.undoAsync()).resolves.toBe(true);
    expect(state.model.store.size).toBe(1);
    await expect(state.history.redoAsync()).resolves.toBe(true);
    expect(state.model.store.size).toBe(2);
    expect(state.operations()).toBe(0);
    expect(state.error).not.toHaveBeenCalled();
  });

  it("coalesces stale input layouts, preserves newer source and releases its save guard", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    const release = pausePreparation(state, true);
    const replace = vi.spyOn(state.model, "prepareElementReplacement");
    const input = state.input();
    input.dispatch({ changes: { from: 5, insert: " first" } });
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledTimes(1));
    expect(state.operations()).toBe(1);
    input.dispatch({ changes: { from: 11, insert: " latest" } });
    expect(state.prepare.mock.calls[0]![1].aborted).toBe(true);
    await vi.waitFor(() => expect(state.operations()).toBe(1));
    release();
    await expect(state.session.flush()).resolves.toBe(true);
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({
      source: "Hello first latest",
    });
    expect(replace).toHaveBeenCalledOnce();
    expect(state.history.commandCount).toBe(1);
    expect(state.operations()).toBe(0);
    const finishing = state.session.finish();
    expect(state.session.finish()).toBe(finishing);
    await finishing;
    await state.history.undoAsync();
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({ source: "Hello" });
  });
});

describe("active text ownership", () => {
  it("requests native viewport measurement when the owned scene clip changes", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    const measure = vi.spyOn(state.input(), "requestMeasure");
    state.viewportChanged();
    expect(measure).toHaveBeenCalledOnce();
    state.session.dispose();
    state.viewportChanged();
    expect(measure).toHaveBeenCalledOnce();
  });

  it("cleans up an externally removed active field without waiting for a missing renderer element", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    const removed = await state.model.prepareElementRemoval([state.element.id], {
      isCancelled: () => false,
    });
    if (removed.status !== "prepared" || removed.token === null)
      throw new Error("Expected a prepared removal.");
    state.model.commitPreparedElementMutation(removed.token);
    const readiness = vi
      .spyOn(state.renderer, "waitForTextElement")
      .mockRejectedValue(new Error("Removed element cannot mount."));
    readiness.mockClear();
    await expect(state.session.finish()).resolves.toBe(true);
    expect(readiness).not.toHaveBeenCalled();
    expect(state.session.active).toBe(false);
    expect(state.session.activeId).toBeUndefined();
    expect(state.hasExportPreparation()).toBe(false);
    expect(state.operations()).toBe(0);
    expect(state.error).not.toHaveBeenCalled();
  });

  it("finishes the current native batch through the public export-preparation boundary", async () => {
    const state = mount();
    expect(state.hasExportPreparation()).toBe(false);
    await state.session.edit(state.element.id);
    expect(state.hasExportPreparation()).toBe(true);
    state.input().dispatch({ changes: { from: 5, insert: " exported" } });
    await state.prepareExport();
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({
      source: "Hello exported",
    });
    expect(state.session.active).toBe(false);
    expect(state.hasExportPreparation()).toBe(false);
    expect(state.operations()).toBe(0);
  });

  it("releases pending edit ownership on disposal and prevents a late prepared commit", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    const release = pausePreparation(state);
    state.input().dispatch({ changes: { from: 5, insert: " pending" } });
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledTimes(1));
    expect(state.operations()).toBe(1);
    state.session.dispose();
    expect(state.operations()).toBe(0);
    expect(state.session.active).toBe(false);
    expect(state.hasExportPreparation()).toBe(false);
    release();
    await state.prepare.mock.results[0]!.value;
    expect(state.history.commandCount).toBe(0);
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({ source: "Hello" });
    expect(state.error).not.toHaveBeenCalled();
  });
});

it("finishes a repeated background style without history, a preview arm or a failed pending draft", async () => {
  const state = mount();
  await state.session.edit(state.element.id);
  state.input().contentDOM.blur();
  state.input().dispatch({ selection: { anchor: 0, head: state.element.source.length } });
  expect(state.session.applyStyle("text-background-opacity", 0.5)).toBe(true);
  await expect(state.session.flush()).resolves.toBe(true);
  const revision = state.model.revision;
  const arm = vi.fn(() => true);
  vi.spyOn(state.renderer, "beginPreviewCommit").mockReturnValue({ arm, cancel: vi.fn() });
  expect(state.session.applyStyle("text-background-opacity", 0.5)).toBe(true);
  await expect(state.session.flush()).resolves.toBe(true);
  await expect(state.session.finish()).resolves.toBe(true);
  expect(arm).not.toHaveBeenCalled();
  expect(state.model.revision).toBe(revision);
  expect(state.history.commandCount).toBe(1);
  expect(state.session.active).toBe(false);
  expect(state.operations()).toBe(0);
  expect(state.error).not.toHaveBeenCalled();
});

it("saves invalid TeX as literal source, closes, repairs it and restores it through shared undo", async () => {
  const original = textElement();
  const state = mount({
    ...original,
    style: { ...original.style, fontFamily: "inter" },
    width: 400,
    pivot: { x: original.x + 200, y: original.pivot.y },
  });
  vi.restoreAllMocks();
  const resources = textSessionFontResources();
  Object.defineProperty(state.model, "fontResources", { value: resources });
  const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: async () => [] },
  });
  const math = new PortableMathRenderer(immediateWorkScheduler());
  vi.spyOn(ObsidianTextMathRenderer.prototype, "resolve").mockImplementation((...args) =>
    math.resolve(...args),
  );
  const invalid = "\nText with **bold** and $x+1$.\nUngültige Formel $\\frac{a}{$";
  try {
    await expect(state.session.edit(state.element.id)).resolves.toBe(true);
    state.input().dispatch({ changes: { from: state.input().state.doc.length, insert: invalid } });
    await expect(state.session.finish()).resolves.toBe(true);
    const saved = state.model.store.get(state.element.id)!.element as TextElementV2;
    expect(saved.source).toBe("Hello" + invalid);
    expect(saved.layout.math).toHaveLength(1);
    expect(
      saved.layout.lines.flatMap((line) => line.runs).find((run) => run.text.includes("\\frac")),
    ).toMatchObject({ style: { fontFamily: "jetbrains-mono" } });
    expect(state.session.active).toBe(false);
    expect(state.operations()).toBe(0);
    await state.session.edit(saved.id);
    const source = state.input().state.doc.toString();
    const start = source.lastIndexOf("\\frac");
    state
      .input()
      .dispatch({ changes: { from: start, to: source.length - 1, insert: "\\frac{a}{b}" } });
    await expect(state.session.finish()).resolves.toBe(true);
    expect((state.model.store.get(saved.id)!.element as TextElementV2).layout.math).toHaveLength(2);
    await expect(state.history.undoAsync()).resolves.toBe(true);
    expect(state.model.store.get(saved.id)?.element).toMatchObject({
      source: saved.source,
      layout: saved.layout,
    });
    expect(state.error).not.toHaveBeenCalled();
  } finally {
    state.session.dispose();
    math.dispose();
    if (previousFonts) Object.defineProperty(document, "fonts", previousFonts);
    else Reflect.deleteProperty(document, "fonts");
  }
});

describe("active text formatting and recovery", () => {
  it("summarizes selected semantic Markdown runs rather than the whole field", async () => {
    const state = mount({ ...textElement(), source: "Plain **bold**" });
    await state.session.edit(state.element.id);
    const input = state.input();
    input.contentDOM.blur();
    const bold = () =>
      state.session.controls(new Localization().t)?.find((control) => control.id === "text-bold");
    input.dispatch({ selection: { anchor: 8, head: 12 } });
    expect(bold()).toMatchObject({ checked: true, mixed: false });
    input.dispatch({ selection: { anchor: 0, head: 12 } });
    expect(bold()).toMatchObject({ checked: false, mixed: true });
  });

  it("keeps formatting selection through owned toolbar menus and includes in-flight background changes", async () => {
    const state = mount();
    const input = await openTextSessionRange(state, { anchor: 0, head: 5 });
    const toolbar = document.createElement("button");
    toolbar.className = "inkbook-toolbar-shell";
    document.body.append(toolbar);
    state.outside(toolbar);
    const tableControls = document.createElement("div");
    tableControls.className = "inkbook-text-table-controls-layer";
    const addRow = document.createElement("button");
    addRow.textContent = "Add row";
    tableControls.append(addRow);
    document.body.append(tableControls);
    state.outside(addRow);
    expect(state.session.active).toBe(true);
    expect(state.session.applyStyle("text-background-color", "#EF4444FF")).toBe(true);
    expect(state.session.applyStyle("text-underline", true)).toBe(true);
    await state.session.flush();
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({
      backgroundColor: null,
      ranges: [
        {
          start: 0,
          end: 5,
          style: { underline: true, backgroundColor: { type: "rgba", value: "#EF4444FF" } },
        },
      ],
    });
    expect(input.state.selection.main.from).toBe(0);
    expect(input.state.selection.main.to).toBe(5);
    expect(
      state.session
        .controls(new Localization().t)
        ?.find((control) => control.id === "text-underline"),
    ).toMatchObject({ checked: true });
    expect(state.session.applyStyle("text-background-color", "invalid")).toBe(false);
  });

  it("rejects export and keeps failed input available for retry instead of losing typed source", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    state.prepare.mockRejectedValueOnce(new Error("Font unavailable"));
    state.input().dispatch({ changes: { from: 5, insert: " retained" } });
    await expect(state.prepareExport()).rejects.toThrow("Current text changes");
    expect(state.session.active).toBe(true);
    expect(state.input().state.doc.toString()).toBe("Hello retained");
    expect(state.dispose).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledOnce();
    await expect(state.prepareExport()).resolves.toBeUndefined();
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({
      source: "Hello retained",
    });
    expect(state.dispose).toHaveBeenCalledOnce();
    expect(state.operations()).toBe(0);
  });

  it("flushes native input before canvas history and restores its current document state", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    const input = state.input();
    input.dispatch({ changes: { from: 5, insert: " typed" } });
    await state.session.flush();
    const key = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true });
    input.contentDOM.dispatchEvent(key);
    await vi.waitFor(() => expect(state.session.active).toBe(true));
    await vi.waitFor(() => expect(state.input().state.doc.toString()).toBe("Hello"));
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({ source: "Hello" });
    expect(state.history.canRedo).toBe(true);
    expect(state.error).not.toHaveBeenCalled();
  });
});

describe("native text source coordinates", () => {
  it("summarizes CRLF source selections without rewriting the saved source on entry", async () => {
    const source = "Plain\r\n**bold**";
    const state = mount({ ...textElement(), source });
    await state.session.edit(state.element.id);
    await state.session.flush();
    const input = state.input();
    input.contentDOM.blur();
    input.dispatch({ selection: { anchor: 8, head: 12 } });
    expect(
      state.session.controls(new Localization().t)?.find((control) => control.id === "text-bold"),
    ).toMatchObject({ checked: true });
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({ source });
    expect(state.history.commandCount).toBe(0);
    input.dispatch({ changes: { from: 12, insert: "!" } });
    await state.session.flush();
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({
      source: "Plain\n**bold!**",
    });
    await state.session.finish();
    await state.history.undoAsync();
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({ source });
  });
});
