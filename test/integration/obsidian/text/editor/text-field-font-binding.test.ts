// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { fontResourceCssFamily } from "../../../../../src/domain/text/font-family";
import { TextFieldEditor } from "../../../../../src/obsidian/text/editor/text-field-editor";
import type {
  TextFieldEditorOptions,
  TextFontResourceResolver,
} from "../../../../../src/obsidian/text/editor/text-field-editor-types";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import {
  TextFontBindings,
  textFontBindingsSteps,
} from "../../../../../src/obsidian/embeds/active-editor/text-session-font-bindings";

const regularId = "a".repeat(64);
const boldId = "b".repeat(64);
const italicId = "c".repeat(64);
const bothId = "d".repeat(64);

function family(editor: TextFieldEditor, text: string): string | undefined {
  return [...editor.view.contentDOM.querySelectorAll<HTMLElement>(".inkbook-text-run")]
    .find((node) => node.textContent === text)
    ?.style.fontFamily.replaceAll('"', "");
}

function savedBindings(element: TextElementV2): TextFontBindings {
  const bindings = new TextFontBindings();
  const steps = textFontBindingsSteps(element);
  let step = steps.next();
  while (!step.done) step = steps.next();
  bindings.adopt(element.id, step.value);
  return bindings;
}

function mountBindings(
  element: TextElementV2,
  bindings: TextFontBindings,
  options: {
    readonly fallback: string;
    readonly onChange?: TextFieldEditorOptions["onChange"];
    readonly onPending?: (pending: boolean) => void;
  },
) {
  const container = document.createElement("div");
  document.body.append(container);
  const editor = new TextFieldEditor({
    container,
    element,
    scheduler: immediateWorkScheduler(),
    resolveFontResourceId: (style, range) =>
      bindings.snapshot().resolve(style, range) ?? options.fallback,
    fontResourceBoundaries: (start, end) => bindings.snapshot().boundaries(start, end),
    onChange: (state, changes) => {
      options.onChange?.(state, changes);
      if (changes) bindings.map(changes);
    },
    onFinish: vi.fn(),
    ...(options.onPending === undefined ? {} : { onInputPending: options.onPending }),
  });
  return { editor, container };
}

describe("native editor font face binding", () => {
  it("keeps saved synthesized faces when entering editing and refreshes actual BI bindings from the prepared layout", async () => {
    const source = "**bold** *italic* ***both***";
    const element = { ...textElement(), source };
    const faces = new Map([
      ["bold", regularId],
      ["italic", regularId],
      ["both", regularId],
    ]);
    const resolve = vi.fn<TextFontResourceResolver>((style) => {
      if (style.bold && style.italic) return faces.get("both");
      if (style.bold) return faces.get("bold");
      if (style.italic) return faces.get("italic");
      return regularId;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const editor = new TextFieldEditor({
      container,
      element,
      scheduler: immediateWorkScheduler(),
      resolveFontResourceId: resolve,
      onChange: vi.fn(),
      onFinish: vi.fn(),
    });
    try {
      await Promise.resolve();
      expect(family(editor, "bold")).toBe(fontResourceCssFamily(regularId));
      expect(family(editor, "italic")).toBe(fontResourceCssFamily(regularId));
      expect(family(editor, "both")).toBe(fontResourceCssFamily(regularId));
      const restored = structuredClone(element);
      editor.updateElement(restored);
      await Promise.resolve();
      expect(family(editor, "both")).toBe(fontResourceCssFamily(regularId));
      faces.set("bold", boldId);
      faces.set("italic", italicId);
      faces.set("both", bothId);
      editor.updateElement({ ...restored, layout: { ...restored.layout } });
      await Promise.resolve();
      expect(family(editor, "bold")).toBe(fontResourceCssFamily(boldId));
      expect(family(editor, "italic")).toBe(fontResourceCssFamily(italicId));
      expect(family(editor, "both")).toBe(fontResourceCssFamily(bothId));
      expect(
        resolve.mock.calls.some(
          ([style, range]) => style.bold && style.italic && range?.start === source.indexOf("both"),
        ),
      ).toBe(true);
      expect(editor.source).toBe(source);
    } finally {
      editor.dispose();
      container.remove();
    }
  });
});

describe("source-mapped mixed face bindings", () => {
  it("keeps different saved faces inside one bold word after deleting their separating whitespace", async () => {
    const element = { ...textElement(), source: "**ab CD**" };
    element.layout.lines[0]!.runs = [
      {
        text: "ab ",
        start: 2,
        end: 5,
        x: 0,
        width: 30,
        fontResourceId: regularId,
        style: { bold: true },
      },
      {
        text: "CD",
        start: 5,
        end: 7,
        x: 30,
        width: 25,
        fontResourceId: boldId,
        style: { bold: true },
      },
    ];
    const bindings = savedBindings(element);
    const { editor, container } = mountBindings(element, bindings, { fallback: bothId });
    try {
      await Promise.resolve();
      expect(family(editor, "ab ")).toBe(fontResourceCssFamily(regularId));
      expect(family(editor, "CD")).toBe(fontResourceCssFamily(boldId));
      editor.view.dispatch({ changes: { from: 4, to: 5 }, selection: { anchor: 4 } });
      await editor.flushChanges();
      await Promise.resolve();
      expect(editor.source).toBe("**abCD**");
      expect(family(editor, "ab")).toBe(fontResourceCssFamily(regularId));
      expect(family(editor, "CD")).toBe(fontResourceCssFamily(boldId));
      editor.view.dispatch({ selection: { anchor: 5 } });
      expect(family(editor, "ab")).toBe(fontResourceCssFamily(regularId));
      expect(family(editor, "CD")).toBe(fontResourceCssFamily(boldId));
    } finally {
      editor.dispose();
      container.remove();
    }
  });
});

describe("raw line ending font bindings", () => {
  it("keeps raw saved faces during ephemeral LF preparation and publishes normalization with the first real edit", async () => {
    const source = "One\r\n\r\n**Two**";
    const element = { ...textElement(), source };
    const start = source.indexOf("Two");
    element.layout.lines[0]!.runs = [
      { text: "One", start: 0, end: 3, x: 0, width: 30, fontResourceId: regularId },
      {
        text: "Two",
        start,
        end: start + 3,
        x: 30,
        width: 25,
        fontResourceId: regularId,
        style: { bold: true },
      },
    ];
    const bindings = savedBindings(element);
    const published = vi.fn<TextFieldEditorOptions["onChange"]>();
    const pending = vi.fn();
    const { editor, container } = mountBindings(element, bindings, {
      fallback: boldId,
      onChange: published,
      onPending: pending,
    });
    try {
      await editor.flushChanges();
      await Promise.resolve();
      expect(published).not.toHaveBeenCalled();
      expect(pending).not.toHaveBeenCalled();
      expect(element.source).toBe(source);
      expect(editor.originalSourcePosition(7, 1)).toBe(start);
      expect(family(editor, "Two")).toBe(fontResourceCssFamily(regularId));
      const line = [...editor.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find(
        (node) => node.textContent === "Two",
      );
      expect(line?.style.fontWeight).toBe("700");
      const position = editor.source.indexOf("Two") + 2;
      editor.view.dispatch({
        changes: { from: position, insert: "!" },
        selection: { anchor: position + 1 },
      });
      await editor.flushChanges();
      await Promise.resolve();
      expect(published).toHaveBeenCalledOnce();
      expect(published.mock.lastCall?.[0].source).toBe("One\n\n**Tw!o**");
      expect(published.mock.lastCall?.[1]?.mapPos(start, 1)).toBe(7);
      expect(editor.originalSourcePosition(7, 1)).toBe(7);
      expect(family(editor, "Tw!o")).toBe(fontResourceCssFamily(regularId));
      expect(pending.mock.calls).toEqual([[true], [false]]);
    } finally {
      editor.dispose();
      container.remove();
    }
  });
});
