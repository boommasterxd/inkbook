// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import {
  TextFieldEditor,
  type TextFieldEditorOptions,
} from "../../../../../src/obsidian/text/editor/text-field-editor";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { textElement } from "../../../../unit/domain/schema/fixtures";

const editors: TextFieldEditor[] = [];

function mount(source = "Hello", overrides: Partial<TextFieldEditorOptions> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const frames = new ManualFrameScheduler();
  const element = { ...textElement(), source };
  const onChange = vi.fn<TextFieldEditorOptions["onChange"]>();
  const onSelectionChange = vi.fn();
  const onUndoRedo = vi.fn();
  const onFinish = vi.fn();
  const onError = vi.fn();
  const scheduler = workSchedulerFromFrames({
    requestAnimationFrame: frames.requestFrame.bind(frames),
    cancelAnimationFrame: frames.cancelFrame.bind(frames),
  });
  const editor = new TextFieldEditor({
    container,
    element,
    scheduler,
    onChange,
    onSelectionChange,
    onUndoRedo,
    onFinish,
    onError,
    ...overrides,
  });
  editors.push(editor);
  const flush = () => {
    while (frames.pendingCount) frames.runNext();
  };
  return {
    editor,
    container,
    frames,
    flush,
    element,
    onChange,
    onSelectionChange,
    onUndoRedo,
    onFinish,
    onError,
  };
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  document.body.replaceChildren();
});

describe("native text source editor", () => {
  it("formats selected Markdown and retains native selection through menu and history updates", async () => {
    const { editor, onChange, element } = mount();
    editor.view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(editor.applyStyle("text-bold", true)).toBe(true);
    expect(editor.source).toBe("**Hello**");
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 7]);
    await editor.flushChanges();
    expect(onChange.mock.lastCall?.[0]).toEqual({
      source: "**Hello**",
      ranges: [],
      paragraphs: [],
    });
    expect(onChange.mock.lastCall?.[1]?.mapPos(0, 1)).toBe(2);
    expect(onChange.mock.lastCall?.[1]?.mapPos(5, -1)).toBe(7);
    editor.updateElement({ ...element, source: editor.source, height: 80 });
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 7]);
    editor.applyStyle("text-bold", false);
    await editor.flushChanges();
    expect(editor.source).toBe("Hello");
    editor.updateElement(element);
    expect(onChange).toHaveBeenCalledTimes(2);
    editor.focusAt();
    expect(editor.view.hasFocus).toBe(true);
  });

  it("rebases independent rich styles after native edits and applies collapsed typing styles", async () => {
    const { editor, onChange } = mount("Hello world");
    editor.view.dispatch({ selection: { anchor: 6, head: 11 } });
    editor.applyStyle("text-font-size", 24);
    editor.view.dispatch({ changes: { from: 0, insert: "A " }, selection: { anchor: 2 } });
    await editor.flushChanges();
    expect(editor.ranges).toEqual([{ start: 8, end: 13, style: { fontSize: 24 } }]);
    editor.applyStyle("text-underline", true);
    editor.view.dispatch({ changes: { from: 2, insert: "new " }, selection: { anchor: 6 } });
    await editor.flushChanges();
    expect(editor.source).toBe("A new Hello world");
    expect(editor.ranges).toContainEqual({ start: 2, end: 6, style: { underline: true } });
    expect(onChange.mock.lastCall?.[0]).toEqual({
      source: editor.source,
      ranges: editor.ranges,
      paragraphs: [],
    });
  });

  it("routes undo, redo and finish without allowing canvas keyboard handlers to consume input", async () => {
    const { editor, container, onUndoRedo, onFinish } = mount();
    const canvas = vi.fn();
    container.addEventListener("keydown", canvas);
    for (const key of ["z", "y", "Escape"]) {
      editor.view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          ctrlKey: key !== "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    expect(onUndoRedo.mock.calls).toEqual([[false], [true]]);
    await Promise.resolve();
    await Promise.resolve();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(canvas).not.toHaveBeenCalled();
  });
});

describe("native text live preview", () => {
  it("preserves source-authoritative inline syntax while hiding inactive delimiters", () => {
    const { editor, flush } = mount("**bold** and *italic* \\*plain\\*\nend");
    editor.focusAt(editor.source.length);
    flush();
    expect(editor.view.contentDOM.textContent).toBe("bold and italic *plain*end");
    expect(editor.view.state.doc.toString()).toBe("**bold** and *italic* \\*plain\\*\nend");
    editor.focusAt(4);
    expect(editor.view.contentDOM.querySelector(".cm-formatting")?.textContent).toBe("**");
    const strong = [
      ...editor.view.contentDOM.querySelectorAll<HTMLElement>(".inkbook-text-run"),
    ].find((node) => node.textContent === "bold");
    expect(strong?.style.fontWeight).toBe("700");
  });

  it("applies heading structure on the next admitted preview without leaving the active line", () => {
    const { editor, flush } = mount("Title\nend");
    editor.view.dispatch({ changes: { from: 0, insert: "# " }, selection: { anchor: 2 } });
    flush();
    expect(editor.view.contentDOM.querySelector(".cm-header-1")?.textContent).toBe("# Title");
    expect(editor.view.contentDOM.querySelector(".cm-formatting")?.textContent).toBe("# ");
    editor.focusAt(editor.source.length);
    expect(editor.view.contentDOM.querySelector(".cm-header-1")?.textContent).toBe("Title");
  });

  it("coalesces source parsing and cancels pending work when the editor is disposed", () => {
    const { editor, frames, flush, onError, onChange } = mount("a");
    editor.view.dispatch({ changes: { from: 1, insert: "b" } });
    editor.view.dispatch({ changes: { from: 2, insert: "c" } });
    expect(frames.pendingCount).toBe(1);
    flush();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.lastCall?.[0].source).toBe("abc");
    editor.view.dispatch({ changes: { from: 3, insert: "d" } });
    editor.dispose();
    expect(frames.pendingCount).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    expect(editor.view.dom.isConnected).toBe(false);
  });

  it("discards a cooperatively suspended stale parser after native input", async () => {
    let release: (() => void) | undefined;
    let pause = true;
    const scheduler = {
      ...immediateWorkScheduler(),
      checkpoint: () =>
        pause
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : undefined,
    };
    const { editor, onError } = mount("**old**", { scheduler });
    await Promise.resolve();
    editor.view.dispatch({ changes: { from: 0, to: 7, insert: "new" } });
    pause = false;
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.source).toBe("new");
    expect(editor.view.contentDOM.querySelector(".cm-formatting")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("formatted source transaction mapping", () => {
  it("styles each explicit source line with its own paragraph alignment", () => {
    const source = "First\nSecond";
    const { editor, flush, onError } = mount(source, {
      element: { ...textElement(), source, paragraphs: [{ start: 6, alignment: "right" }] },
    });
    flush();
    expect(
      [...editor.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].map(
        (line) => line.style.textAlign,
      ),
    ).toEqual(["left", "right"]);
    editor.view.dispatch({ selection: { anchor: 8 } });
    editor.applyStyle("text-alignment", "center");
    flush();
    expect(onError).not.toHaveBeenCalled();
    expect(editor.source).toBe(source);
    expect(
      [...editor.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].map(
        (line) => line.style.textAlign,
      ),
    ).toEqual(["left", "center"]);
  });

  it("aligns the caret's canonical paragraph after markup and CRLF normalization", async () => {
    const source = "**First**\r\n\r\nSecond paragraph\r\n\r\nThird";
    const { editor, onChange } = mount(source);
    const canonical = editor.source;
    const second = canonical.indexOf("Second");
    const third = canonical.indexOf("Third");
    editor.view.dispatch({ selection: { anchor: second + 3 } });
    editor.applyStyle("text-alignment", "center");
    await editor.flushChanges();
    expect(editor.paragraphs).toEqual([
      { start: second, alignment: "center" },
      { start: third - 1, alignment: "left" },
    ]);
    expect(onChange.mock.lastCall?.[1]?.mapPos(source.indexOf("Second"), 1)).toBe(second);
    expect(editor.selectionStart).toBe(second + 3);
    const selection = editor.view.state.selection;
    editor.focusSelectionPreserved();
    expect(editor.view.hasFocus).toBe(true);
    expect(editor.view.state.selection).toBe(selection);
  });

  it("formats multiple Markdown blocks in one native transaction and preserves independent rich ranges", async () => {
    const source = "# Heading\n\nFirst plain\n\n- List item";
    const { editor, onChange } = mount(source);
    const start = source.indexOf("plain");
    editor.view.dispatch({ selection: { anchor: start, head: start + 5 } });
    editor.applyStyle("text-font-size", 24);
    onChange.mockClear();
    editor.view.dispatch({ selection: { anchor: 0, head: source.length } });
    editor.applyStyle("text-bold", true);
    expect(onChange).not.toHaveBeenCalled();
    await editor.flushChanges();
    expect(editor.source).toBe("# **Heading**\n\n**First plain**\n\n- **List item**");
    const parsed = parseTextMarkdown(editor.source, {
      style: textElement().style,
      ranges: editor.ranges,
    });
    const runs = parsed.blocks.flatMap((block) => block.runs);
    expect(runs.find((run) => run.text === "plain")?.style.fontSize).toBe(24);
    expect(
      runs.filter((run) => run.text !== "plain").every((run) => run.style.fontSize === 16.5),
    ).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("transient caret formatting", () => {
  it("distinguishes generated formatting from literal user input without interpreting Markdown characters", async () => {
    const { editor } = mount("");
    editor.applyStyle("text-bold", true);
    await editor.flushChanges();
    expect(editor.hasMeaningfulUserInput).toBe(false);
    const at = editor.selectionStart;
    editor.view.dispatch({ changes: { from: at, insert: " " }, selection: { anchor: at + 1 } });
    expect(editor.hasMeaningfulUserInput).toBe(false);
    editor.view.dispatch({ changes: { from: editor.selectionStart, insert: "$" } });
    expect(editor.hasMeaningfulUserInput).toBe(true);
  });

  it("reports next-input styles, preserves them while typing and clears them on a real caret move", async () => {
    const { editor, onChange } = mount("Plain ");
    editor.focusAt(6);
    editor.applyStyle("text-font-family", "source-serif");
    editor.applyStyle("color", { type: "rgba", value: "#3B82F6FF" });
    editor.applyStyle("text-underline", true);
    expect(editor.pendingTextStyle).toEqual({
      fontFamily: "source-serif",
      color: { type: "rgba", value: "#3B82F6FF" },
      underline: true,
    });
    expect(onChange).not.toHaveBeenCalled();
    editor.applyStyle("text-underline", false);
    editor.view.dispatch({ changes: { from: 6, insert: "x" }, selection: { anchor: 7 } });
    await editor.flushChanges();
    expect(editor.ranges).toEqual([{ start: 6, end: 7, style: editor.pendingTextStyle }]);
    expect(editor.pendingTextStyle.underline).toBe(false);
    editor.focusAt(7);
    expect(editor.pendingTextStyle.fontFamily).toBe("source-serif");
    editor.focusAt(0);
    expect(editor.pendingTextStyle).toEqual({});
  });

  it.each([
    ["bold", "**"],
    ["italic", "*"],
    ["strikethrough", "~~"],
  ] as const)(
    "keeps %s source-authoritative through empty-pair toggles and subsequent typing",
    async (mark, delimiter) => {
      const { editor, flush } = mount("");
      editor.focusAt(0);
      editor.applyStyle(`text-${mark}`, true);
      expect(editor.source).toBe(`${delimiter}${delimiter}`);
      expect(editor.pendingTextStyle[mark]).toBe(true);
      editor.applyStyle(`text-${mark}`, false);
      expect(editor.source).toBe("");
      expect(editor.pendingTextStyle[mark]).toBe(false);
      editor.applyStyle(`text-${mark}`, true);
      editor.view.dispatch({
        changes: { from: editor.selectionStart, insert: "x" },
        selection: { anchor: editor.selectionStart + 1 },
      });
      await editor.flushChanges();
      flush();
      expect(editor.pendingTextStyle[mark]).toBe(true);
      expect(editor.ranges).toEqual([]);
      editor.applyStyle(`text-${mark}`, false);
      expect(editor.pendingTextStyle[mark]).toBe(false);
      editor.view.dispatch({
        changes: { from: editor.selectionStart, insert: "y" },
        selection: { anchor: editor.selectionStart + 1 },
      });
      await editor.flushChanges();
      const parsed = parseTextMarkdown(editor.source, { style: textElement().style });
      const runs = parsed.blocks.flatMap((block) => block.runs);
      expect(runs.find((run) => run.text === "x")?.style[mark]).toBe(true);
      expect(runs.find((run) => run.text === "y")?.style[mark]).toBe(false);
      expect(editor.ranges).toEqual([]);
      editor.focusAt(0);
      expect(editor.pendingTextStyle).toEqual({});
    },
  );
});

describe("caret Markdown continuation", () => {
  it("rejoins a toggled mark inside a word and lets selected source removal clear the formatting", async () => {
    const { editor } = mount("**hello**");
    editor.view.dispatch({ selection: { anchor: 4 } });
    editor.applyStyle("text-bold", false);
    expect(editor.source).toBe("**he****llo**");
    expect(editor.pendingTextStyle.bold).toBe(false);
    editor.applyStyle("text-bold", true);
    expect(editor.source).toBe("**hello**");
    expect(editor.selectionStart).toBe(4);
    expect(editor.pendingTextStyle.bold).toBe(true);
    editor.view.dispatch({ selection: { anchor: 2, head: 7 } });
    editor.applyStyle("text-bold", false);
    await editor.flushChanges();
    expect(editor.source).toBe("hello");
    expect(editor.ranges).toEqual([]);
    expect(editor.pendingTextStyle).toEqual({});
  });
});

describe("combined selected-word formatting", () => {
  it("honors explicit repeated menu states at an empty caret while keyboard shortcuts remain toggles", async () => {
    const { editor, onError } = mount("");
    const marks = ["bold", "italic", "underline", "strikethrough"] as const;
    for (const enabled of [true, false, true]) {
      for (const mark of marks) {
        editor.applyStyle(`text-${mark}`, enabled);
        const source = editor.source;
        editor.applyStyle(`text-${mark}`, enabled);
        expect(editor.source).toBe(source);
      }
      expect(editor.pendingTextStyle).toMatchObject(
        Object.fromEntries(marks.map((mark) => [mark, enabled])),
      );
      if (!enabled) expect(editor.source).toBe("");
    }
    const at = editor.selectionStart;
    editor.view.dispatch({ changes: { from: at, insert: "Write" }, selection: { anchor: at + 5 } });
    await editor.flushChanges();
    const word = parseTextMarkdown(editor.source, {
      style: textElement().style,
      ranges: editor.ranges,
    })
      .blocks.flatMap((block) => block.runs)
      .find((run) => run.text === "Write");
    expect(word?.style).toMatchObject(Object.fromEntries(marks.map((mark) => [mark, true])));
    for (const range of editor.ranges) {
      expect(range.style.bold).toBeUndefined();
      expect(range.style.italic).toBeUndefined();
      expect(range.style.strikethrough).toBeUndefined();
    }
    editor.view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(editor.pendingTextStyle.bold).toBe(false);
    editor.view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(editor.pendingTextStyle.bold).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("independently toggles all four formats repeatedly without losing the word or adding empty markers", async () => {
    const source = "# Heading\n\nWrite the next paragraph.";
    const { editor, element } = mount(source);
    const start = source.indexOf("Write");
    editor.view.dispatch({ selection: { anchor: start, head: start + 5 } });
    for (const enabled of [true, false, true]) {
      for (const mark of ["bold", "italic", "underline", "strikethrough"] as const) {
        expect(editor.applyStyle(`text-${mark}`, enabled)).toBe(true);
        await editor.flushChanges();
        expect(editor.source.slice(editor.selectionStart, editor.selectionEnd)).toBe("Write");
        editor.updateElement({
          ...element,
          source: editor.source,
          ranges: [...editor.ranges],
          paragraphs: [...editor.paragraphs],
        });
        expect(editor.source.slice(editor.selectionStart, editor.selectionEnd)).toBe("Write");
      }
      expect(editor.source).toBe(
        enabled ? "# Heading\n\n***~~Write~~*** the next paragraph." : source,
      );
      const runs = parseTextMarkdown(editor.source, {
        style: element.style,
        ranges: editor.ranges,
      }).blocks.flatMap((block) => block.runs);
      const word = runs.find((run) => run.text === "Write");
      expect(word?.style).toMatchObject({
        bold: enabled,
        italic: enabled,
        underline: enabled,
        strikethrough: enabled,
      });
    }
  });
});

describe("native source line endings", () => {
  it.each(["\r\n", "\r"])(
    "normalizes %j on editor entry while mapping ranges and the first native edit together",
    async (separator) => {
      const source = `One${separator}Two`;
      const start = source.indexOf("Two");
      const element = {
        ...textElement(),
        source,
        ranges: [{ start, end: source.length, style: { fontSize: 24 } }],
        paragraphs: [{ start, alignment: "right" as const }],
      };
      const { editor, onChange } = mount(source, { element });
      expect(editor.view.state.doc.toString()).toBe("One\nTwo");
      const end = editor.view.state.doc.length;
      editor.view.dispatch({ changes: { from: end, insert: "!" }, selection: { anchor: end + 1 } });
      await editor.flushChanges();
      expect(editor.source).toBe("One\nTwo!");
      expect(onChange.mock.lastCall?.[0]).toEqual({
        source: "One\nTwo!",
        ranges: [{ start: 4, end: 8, style: { fontSize: 24 } }],
        paragraphs: [{ start: 4, alignment: "right" }],
      });
      expect(onChange.mock.lastCall?.[1]?.mapPos(start, 1)).toBe(4);
      expect(onChange.mock.lastCall?.[1]?.mapPos(source.length, 1)).toBe(8);
    },
  );

  it("keeps initial normalization ephemeral until a range style edit publishes the coherent source state", async () => {
    const element = {
      ...textElement(),
      source: "One\r\nTwo",
      ranges: [{ start: 5, end: 8, style: { fontSize: 24 } }],
    };
    const { editor, onChange, flush } = mount(element.source, { element });
    flush();
    await editor.flushChanges();
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.ranges).toEqual([{ start: 4, end: 7, style: { fontSize: 24 } }]);
    editor.view.dispatch({ selection: { anchor: 4, head: 7 } });
    editor.applyStyle("text-font-size", 26);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.lastCall?.[0]).toEqual({
      source: "One\nTwo",
      ranges: [{ start: 4, end: 7, style: { fontSize: 26 } }],
      paragraphs: [],
    });
    expect(onChange.mock.lastCall?.[1]?.mapPos(5, 1)).toBe(4);
    expect(editor.originalSourcePosition(4, 1)).toBe(4);
  });
});
