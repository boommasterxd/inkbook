// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fontResourceCssFamily } from "../../../../../src/domain/text/font-family";
import {
  TextFieldEditor,
  type TextFieldEditorOptions,
} from "../../../../../src/obsidian/text/editor/text-field-editor";
import { TextMathSyntaxError } from "../../../../../src/rendering/text/text-math-syntax-error";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { textElement } from "../../../../unit/domain/schema/fixtures";

const editors: TextFieldEditor[] = [];

function mount(
  source: string,
  renderMath: (latex: string, display: boolean, signal: AbortSignal) => Promise<HTMLElement>,
  options: Partial<TextFieldEditorOptions> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const frames = new ManualFrameScheduler();
  const scheduler = workSchedulerFromFrames({
    requestAnimationFrame: frames.requestFrame.bind(frames),
    cancelAnimationFrame: frames.cancelFrame.bind(frames),
  });
  const onError = vi.fn();
  const onChange = vi.fn();
  const editor = new TextFieldEditor({
    container,
    element: { ...textElement(), source },
    scheduler,
    renderMath,
    onChange,
    onFinish: vi.fn(),
    onError,
    ...options,
  });
  editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
  while (frames.pendingCount) frames.runNext();
  editors.push(editor);
  const flush = () => {
    while (frames.pendingCount) frames.runNext();
  };
  return { editor, onError, onChange, flush };
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  document.body.replaceChildren();
});

function expectDisplayFormula(
  render: ReturnType<typeof vi.fn>,
  source: string,
  latex: string,
  fontSize: number,
): void {
  expect(render).toHaveBeenCalledWith(latex, true, expect.any(AbortSignal), {
    fontSize,
    availableWidth: 100,
    bold: false,
    sourceRange: { start: 0, end: source.indexOf("\nend") },
    layout: expect.anything() as unknown,
  });
}

describe("heading formula formatting", () => {
  it("passes heading size and effective bold overrides to formula previews without rewriting source", async () => {
    const source = "# Heading $x$\n\nend";
    const render = vi.fn(async () => document.createElement("span"));
    const { editor, flush, onChange } = mount(source, render);
    await Promise.resolve();
    expect(render).toHaveBeenLastCalledWith("x", false, expect.any(AbortSignal), {
      fontSize: 33,
      availableWidth: 100,
      bold: true,
      sourceRange: { start: source.indexOf("$"), end: source.lastIndexOf("$") + 1 },
      layout: expect.anything() as unknown,
    });
    const original = { ...textElement(), source };
    editor.updateElement({
      ...original,
      ranges: [
        {
          start: source.indexOf("$"),
          end: source.indexOf("$", source.indexOf("$") + 1) + 1,
          style: { bold: false },
        },
      ],
    });
    flush();
    await Promise.resolve();
    expect(render).toHaveBeenLastCalledWith("x", false, expect.any(AbortSignal), {
      fontSize: 33,
      availableWidth: 100,
      bold: false,
      sourceRange: { start: source.indexOf("$"), end: source.lastIndexOf("$") + 1 },
      layout: expect.anything() as unknown,
    });
    expect(editor.source).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("formula preview font binding", () => {
  it("binds normalized native formula ranges to the original saved CRLF source", async () => {
    const source = "before\r\n$x$\r\nend";
    const render = vi.fn(async () => document.createElement("span"));
    const { onChange } = mount(source, render);
    await Promise.resolve();
    expect(render).toHaveBeenLastCalledWith("x", false, expect.any(AbortSignal), {
      fontSize: 16.5,
      availableWidth: 100,
      bold: false,
      sourceRange: { start: 8, end: 11 },
      layout: expect.anything() as unknown,
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("binds inline math to its resolved font resource", async () => {
    const source = "$x$ end";
    const face = "a".repeat(64);
    const render = vi.fn(async () => document.createElement("span"));
    const { editor, onChange } = mount(source, render, {
      resolveFontResourceId: () => face,
    });
    await Promise.resolve();
    const widget = editor.view.contentDOM.querySelector<HTMLElement>(".inkbook-text-math-widget");
    expect(widget?.style.fontFamily.replaceAll('"', "")).toBe(fontResourceCssFamily(face));
    expect(editor.source).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses the block font strut independently of the display formula's range size", async () => {
    const source = "$$\nx\n$$\nend";
    const face = "b".repeat(64);
    const render = vi.fn(async () => document.createElement("span"));
    const { editor, onChange } = mount(source, render, {
      element: {
        ...textElement(),
        source,
        ranges: [{ start: 0, end: source.indexOf("\nend"), style: { fontSize: 30 } }],
      },
      resolveFontResourceId: () => face,
    });
    await Promise.resolve();
    const widget = editor.view.contentDOM.querySelector<HTMLElement>(".inkbook-text-math-display");
    expect(widget?.style.fontFamily.replaceAll('"', "")).toBe(fontResourceCssFamily(face));
    expect(widget?.style.fontSize).toBe("16.5px");
    expectDisplayFormula(render, source, "x", 30);
    editor.view.dispatch({ selection: { anchor: 3 } });
    expect(editor.view.contentDOM.querySelector(".inkbook-text-math-widget")).toBeNull();
    expect(editor.source).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("in-place formula editing", () => {
  it("retains rendered inline math across unrelated native cursor moves and reveals source when clicked", async () => {
    const render = vi.fn(async () => {
      const node = document.createElement("span");
      node.textContent = "Rendered fraction";
      return node;
    });
    const { editor, onChange, onError } = mount("$\\frac{a}{b}$ and **bold**", render);
    await Promise.resolve();
    const widget = editor.view.contentDOM.querySelector(".inkbook-text-math-widget");
    expect(widget?.textContent).toBe("Rendered fraction");
    editor.view.dispatch({ selection: { anchor: 20 } });
    expect(editor.view.contentDOM.querySelector(".inkbook-text-math-widget")).toBe(widget);
    expect(render).toHaveBeenCalledOnce();
    widget?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(editor.selectionStart).toBe(1);
    expect(editor.view.contentDOM.querySelector(".inkbook-text-math-widget")).toBeNull();
    expect(editor.view.contentDOM.querySelector(".cm-tag")?.textContent).toBe("\\frac");
    expect(editor.source).toBe("$\\frac{a}{b}$ and **bold**");
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["left", "center", "right"] as const)(
    "keeps display math %s aligned before revealing its multiline source",
    async (alignment) => {
      const render = vi.fn(async () => document.createElement("span"));
      const source = "$$\na^2+b^2=c^2\n$$\nend";
      const { editor } = mount(source, render, {
        element: { ...textElement(), source, paragraphs: [{ start: 0, alignment }] },
      });
      await Promise.resolve();
      const widget = editor.view.contentDOM.querySelector<HTMLElement>(
        ".inkbook-text-math-display",
      );
      expect(widget).not.toBeNull();
      expect(widget?.style.textAlign).toBe(alignment);
      expectDisplayFormula(render, source, "a^2+b^2=c^2", 16.5);
      editor.view.dispatch({ selection: { anchor: 5 } });
      expect(editor.view.contentDOM.querySelector(".inkbook-text-math-widget")).toBeNull();
      expect(editor.view.state.doc.toString()).toBe(source);
      expect(editor.view.contentDOM.querySelector(".cm-tag")?.textContent).toBe("^");
    },
  );
});

describe("owned formula field layout", () => {
  it("shares stored field insets with native input and list math without rewriting legacy source", async () => {
    const source = "- $x$ end";
    const original = { ...textElement(), source };
    const element = { ...original, layout: { ...original.layout, padding: 8.25 } };
    const render = vi.fn(async () => document.createElement("span"));
    const { editor, flush, onChange } = mount(source, render, { element });
    await Promise.resolve();
    expect(editor.view.contentDOM.style.padding).toBe("8.25px");
    expect(editor.view.dom.style.padding).toBe("");
    expect(render).toHaveBeenLastCalledWith("x", false, expect.any(AbortSignal), {
      fontSize: 16.5,
      availableWidth: 58.75,
      bold: false,
      sourceRange: { start: 2, end: 5 },
      layout: expect.anything() as unknown,
    });
    const selection = editor.view.state.selection;
    editor.updateElement(original);
    flush();
    await Promise.resolve();
    expect(editor.view.contentDOM.style.padding).toBe("0px");
    expect(render).toHaveBeenLastCalledWith("x", false, expect.any(AbortSignal), {
      fontSize: 16.5,
      availableWidth: 75.25,
      bold: false,
      sourceRange: { start: 2, end: 5 },
      layout: expect.anything() as unknown,
    });
    expect(editor.view.state.selection.eq(selection)).toBe(true);
    expect(editor.source).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("aborts owned asynchronous rendering and ignores late results after disposal", async () => {
    let resolve: ((node: HTMLElement) => void) | undefined;
    let signal: AbortSignal | undefined;
    const render = vi.fn((_latex: string, _display: boolean, abort: AbortSignal) => {
      signal = abort;
      return new Promise<HTMLElement>((finish) => {
        resolve = finish;
      });
    });
    const { editor, onError } = mount("$x$ end", render);
    const widget = editor.view.contentDOM.querySelector(".inkbook-text-math-widget");
    editor.dispose();
    expect(signal?.aborted).toBe(true);
    const late = document.createElement("span");
    late.textContent = "Late";
    resolve?.(late);
    await Promise.resolve();
    expect(widget?.textContent).toBe("x");
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("native TeX source classes", () => {
  it("reveals native token and delimiter classes in the same editor while retaining the complete source", () => {
    const source = "$x^2+\\frac{1}{2}$";
    const { editor, onChange } = mount(source, async () => document.createElement("span"));
    const content = editor.view.contentDOM;
    expect([...content.querySelectorAll(".cm-tag")].map((node) => node.textContent)).toEqual([
      "^",
      "\\frac",
    ]);
    expect(content.querySelector(".cm-variable-2")?.textContent).toBe("x");
    expect([...content.querySelectorAll(".cm-number")].map((node) => node.textContent)).toEqual([
      "2",
      "1",
      "2",
    ]);
    expect(
      [...content.querySelectorAll(".cm-bracket")].map((node) => node.textContent).join(""),
    ).toBe("{}{}");
    expect(
      [...content.querySelectorAll(".cm-formatting-math")].map((node) => node.textContent),
    ).toEqual(["$", "$"]);
    expect(editor.source).toBe(source);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("editable mathematical syntax errors", () => {
  it.each(["$ \\frac{a}{ $", "$$\n  \\frac{a}{ \n$$"])(
    "keeps every original delimiter and whitespace in %j without reporting a technical failure",
    async (literal) => {
      const source = `${literal}\nend`;
      const { editor, onError, onChange } = mount(source, async () => {
        throw new TextMathSyntaxError("MissingCloseBrace");
      });
      await Promise.resolve();
      const widget = editor.view.contentDOM.querySelector<HTMLElement>(
        ".inkbook-text-math-literal",
      );
      expect(widget?.textContent).toBe(literal);
      expect(widget?.getAttribute("aria-busy")).toBeNull();
      expect(widget?.getAttribute("role")).toBeNull();
      expect(widget?.style.textAlign).toBe("left");
      expect(widget?.querySelector<HTMLElement>(".cm-inline-code")?.style.fontFamily).toContain(
        "inkbook-jetbrains-mono",
      );
      widget?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      expect(editor.view.contentDOM.querySelector(".inkbook-text-math-widget")).toBeNull();
      expect(editor.source).toBe(source);
      expect(onError).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("preserves separately bound code faces inside the literal source and can render repaired source", async () => {
    const source = "$\\frac{a}{$ end";
    const oldFace = "a".repeat(64);
    const newFace = "b".repeat(64);
    const resolveFontResourceId = vi.fn<
      NonNullable<TextFieldEditorOptions["resolveFontResourceId"]>
    >((style, range) => {
      if (style.fontFamily !== "jetbrains-mono") return undefined;
      return range && range.end <= 2 ? oldFace : newFace;
    });
    const render = vi.fn(async (latex: string) => {
      if (!latex.endsWith("b}")) throw new TextMathSyntaxError("MissingCloseBrace");
      const span = document.createElement("span");
      span.textContent = "Repaired fraction";
      return span;
    });
    const { editor, onError, flush } = mount(source, render, {
      resolveFontResourceId,
      fontResourceBoundaries: () => [2],
    });
    await Promise.resolve();
    const fragments = [
      ...editor.view.contentDOM.querySelectorAll<HTMLElement>(
        ".inkbook-text-math-literal .cm-inline-code",
      ),
    ];
    expect(fragments.map((span) => span.textContent)).toEqual(["$\\", "frac{a}{$"]);
    expect(fragments.map((span) => span.style.fontFamily)).toEqual([
      `inkbook-face-${oldFace}`,
      `inkbook-face-${newFace}`,
    ]);
    const closingDollar = source.indexOf("$", 1);
    editor.view.dispatch({
      changes: { from: closingDollar, insert: "b}" },
      selection: { anchor: source.length + 2 },
    });
    await editor.flushChanges();
    flush();
    await Promise.resolve();
    expect(editor.source).toBe("$\\frac{a}{b}$ end");
    expect(editor.view.contentDOM.querySelector(".inkbook-text-math-widget")?.textContent).toBe(
      "Repaired fraction",
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports resource and renderer failures instead of treating them as literal source", async () => {
    const failure = new Error("Unavailable mathematical font resource.");
    const { editor, onError } = mount("$x$ end", async () => {
      throw failure;
    });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(editor.view.contentDOM.querySelector(".inkbook-text-math-literal")).toBeNull();
  });
});

describe("literal mathematical source reuse", () => {
  it("updates original whitespace when normalized LaTeX and replacement length stay unchanged", async () => {
    const literal = "$ \\frac{a}{ $";
    const edited = "$\\frac{a}{  $";
    const render = vi.fn(async () => {
      throw new TextMathSyntaxError("MissingCloseBrace");
    });
    const { editor, flush, onError } = mount(`${literal}\nend`, render);
    await Promise.resolve();
    editor.view.dispatch({ changes: { from: 0, to: literal.length, insert: edited } });
    await editor.flushChanges();
    flush();
    await Promise.resolve();
    expect(editor.view.contentDOM.querySelector(".inkbook-text-math-literal")?.textContent).toBe(
      edited,
    );
    expect(render).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
