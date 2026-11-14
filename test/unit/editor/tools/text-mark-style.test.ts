import { afterEach, expect, it, vi } from "vitest";
import type { TextElementV2 } from "../../../../src/domain/schema/public";
import * as parser from "../../../../src/domain/text/markdown-parser";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { ElementStore } from "../../../../src/domain/store/public";
import { applySelectionStyleChange } from "../../../../src/editor/tools/style-change";
import { summarizeSelectionStyle } from "../../../../src/editor/tools/style-summary";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/document-session/document-model-port";
import { layoutTextElement } from "../../../fixtures/editor/text-style";
import { elementReplacementPorts } from "../../../fixtures/obsidian/element-mutation-ports";
import { textElement } from "../../domain/schema/fixtures";

afterEach(() => vi.restoreAllMocks());

it("summarizes persisted Markdown/heading/code glyph styles without reparsing or scaling the font-size control", async () => {
  const bold = await layoutTextElement({ ...textElement(), source: "**bold**" });
  const heading = await layoutTextElement({
    ...textElement(),
    source: "# Title",
    ranges: [{ start: 2, end: 7, style: { fontSize: 20.125 } }],
  });
  const mixed = await layoutTextElement({ ...textElement(), source: "**bold** plain `code`" });
  const parsing = vi.spyOn(parser, "parseTextMarkdownSteps");
  expect(summarizeSelectionStyle([bold])).toMatchObject({ kind: "text", style: { bold: true } });
  expect(summarizeSelectionStyle([heading])).toMatchObject({
    style: { bold: true, fontSize: 20.125 },
  });
  expect(summarizeSelectionStyle([mixed])).toMatchObject({
    style: { bold: "mixed", fontFamily: "mixed" },
  });
  expect(parsing).not.toHaveBeenCalled();
});

it.each([
  ["bold", "**bold**", "**bold**", "bold"],
  ["bold", "**bold** plain", "**bold plain**", "bold plain"],
  ["italic", "*italic* plain", "*italic plain*", "italic plain"],
  ["strikethrough", "~~gone~~ plain", "~~gone plain~~", "gone plain"],
] as const)(
  "forces whole-object %s on and off with coherent Markdown and no repeated no-op command",
  async (mark, source, enabled, disabled) => {
    const original = await layoutTextElement({ ...textElement(), source });
    const on = applySelectionStyleChange([original], { property: `text-${mark}`, value: true });
    expect(on.changed).toBe(true);
    expect((on.elements[0] as TextElementV2).source).toBe(enabled);
    const off = applySelectionStyleChange([original], { property: `text-${mark}`, value: false });
    expect(off.changed).toBe(true);
    const updated = await layoutTextElement(off.elements[0] as TextElementV2);
    expect(updated.source).toBe(disabled);
    const summary = summarizeSelectionStyle([updated]);
    if (summary?.kind !== "text") throw new Error("Missing text style summary.");
    expect(summary.style[mark]).toBe(false);
    const unchanged = applySelectionStyleChange([updated], {
      property: `text-${mark}`,
      value: false,
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.elements[0]).toBe(updated);
  },
);

it("removes Markdown-only bold, preserves other marks and rebases independent ranges/paragraphs in one undoable change", async () => {
  const source = "**one *both***\n\n~~two~~";
  const start = source.indexOf("both");
  const two = source.indexOf("~~two~~");
  const original = await layoutTextElement({
    ...textElement(),
    source,
    ranges: [{ start, end: start + 4, style: { bold: true, underline: true, fontSize: 21.125 } }],
    paragraphs: [
      { start: 0, alignment: "center" },
      { start: two, alignment: "right" },
    ],
  });
  const store = new ElementStore([original]);
  const model = { store, ...elementReplacementPorts(store) } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const result = applySelectionStyleChange([original], { property: "text-bold", value: false });
  expect(result.changed).toBe(true);
  const updated = await layoutTextElement(result.elements[0] as TextElementV2);
  expect(updated.source).toBe("one *both*\n\n~~two~~");
  const offset = updated.source.indexOf("both");
  expect(updated.ranges).toEqual([
    { start: offset, end: offset + 4, style: { underline: true, fontSize: 21.125 } },
  ]);
  expect(updated.paragraphs).toEqual([
    { start: 0, alignment: "center" },
    { start: updated.source.indexOf("~~two~~"), alignment: "right" },
  ]);
  const document = parseTextMarkdown(updated.source, updated);
  expect(
    document.blocks.flatMap((block) => block.runs).find(({ text }) => text === "both")?.style,
  ).toMatchObject({ bold: false, italic: true, underline: true, fontSize: 21.125 });
  expect(
    document.blocks.flatMap((block) => block.runs).find(({ text }) => text === "two")?.style
      .strikethrough,
  ).toBe(true);
  expect(history.replace([original], [updated])).toBe(true);
  expect(store.get(original.id)?.element).toEqual(updated);
  expect(history.undo()).toBe(true);
  expect(store.get(original.id)?.element).toEqual(original);
  expect(history.undo()).toBe(false);
  expect(history.redo()).toBe(true);
  expect(store.get(original.id)?.element).toEqual(updated);
});

it("uniformly clears whole-field bold across headings and paragraphs while retaining heading structure and independent styles", async () => {
  const original = await layoutTextElement({
    ...textElement(),
    source: "# **Title**\n\n**Paragraph** plain `**literal**`",
    style: { ...textElement().style, bold: true },
    ranges: [{ start: 4, end: 9, style: { bold: true, underline: true } }],
  });
  const result = applySelectionStyleChange([original], { property: "text-bold", value: false });
  const updated = await layoutTextElement(result.elements[0] as TextElementV2);
  expect(updated.source).toBe("# Title\n\nParagraph plain `**literal**`");
  expect(updated.style.bold).toBe(false);
  expect(updated.layout.lines[0]!.runs[0]?.style).toMatchObject({ bold: false, underline: true });
  expect(
    updated.layout.lines.flatMap((line) => line.runs).every((run) => run.style?.bold === false),
  ).toBe(true);
  expect(updated.ranges.some((range) => range.style.bold === true)).toBe(false);
  expect(summarizeSelectionStyle([updated])).toMatchObject({
    kind: "text",
    style: { bold: false },
  });
  expect(applySelectionStyleChange([updated], { property: "text-bold", value: false })).toEqual({
    elements: [updated],
    changed: false,
  });
});
