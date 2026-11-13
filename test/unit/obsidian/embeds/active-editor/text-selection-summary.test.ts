import { expect, it } from "vitest";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import { textSelectionSummary } from "../../../../../src/obsidian/embeds/active-editor/text-session-presentation";
import { textElement } from "../../../domain/schema/fixtures";

it("preserves effective heading, code, selection-range and paragraph alignment styles", () => {
  const source = "# Title\n\n**bold** and `code`\n\nlast";
  const element = { ...textElement(), source };
  const document = parseTextMarkdown(source, {
    style: element.style,
    paragraphs: [
      { start: 0, alignment: "center" },
      { start: source.indexOf("last"), alignment: "justify" },
    ],
  });
  const title = textSelectionSummary(element, document, 3, 3);
  expect(title.style.bold).toBe(true);
  expect(title.alignment).toBe("center");
  const code = source.indexOf("code");
  expect(textSelectionSummary(element, document, code, code).style.fontFamily).toBe(
    "jetbrains-mono",
  );
  const mixed = textSelectionSummary(element, document, 3, code + 4);
  expect(mixed.style.bold).toBe("mixed");
  expect(mixed.style.fontFamily).toBe("mixed");
  expect(textSelectionSummary(element, document, 3, source.length).alignment).toBe("mixed");
  const eof = textSelectionSummary(element, document, source.length, source.length);
  expect(eof.style).toEqual(element.style);
  expect(eof.alignment).toBe("justify");
});

it("uses exclusive run ends and the source-end exception without selecting Markdown delimiters", () => {
  const source = "abcd";
  const element = { ...textElement(), source };
  const document = parseTextMarkdown(source, {
    style: element.style,
    ranges: [
      { start: 0, end: 2, style: { bold: true } },
      { start: 2, end: 4, style: { italic: true } },
    ],
  });
  expect(textSelectionSummary(element, document, 2, 2).style).toMatchObject({
    bold: false,
    italic: true,
  });
  expect(textSelectionSummary(element, document, 0, 4).style).toMatchObject({
    bold: "mixed",
    italic: "mixed",
  });
  expect(textSelectionSummary(element, document, 4, 4).style.italic).toBe(true);
  const marked = { ...element, source: "**bold**" };
  const parsed = parseTextMarkdown(marked.source, { style: element.style });
  expect(textSelectionSummary(marked, parsed, 6, 6).style.bold).toBe(false);
  expect(textSelectionSummary(marked, parsed, 8, 8).style.bold).toBe(false);
});

it("retains base-style fallback for unavailable or empty parsed content and paragraph gaps", () => {
  const element = { ...textElement(), source: "word\n\n" };
  const parsed = parseTextMarkdown(element.source, {
    style: element.style,
    paragraphs: [{ start: 0, alignment: "right" }],
  });
  expect(textSelectionSummary(element, undefined, 0, 0)).toMatchObject({
    style: element.style,
    alignment: "left",
    backgroundColor: element.backgroundColor,
    backgroundOpacity: element.backgroundOpacity,
  });
  expect(textSelectionSummary(element, parsed, 4, 4)).toMatchObject({
    style: element.style,
    alignment: "right",
  });
  expect(
    textSelectionSummary(element, parsed, element.source.length, element.source.length),
  ).toMatchObject({ style: element.style, alignment: "right" });
  const empty = { ...element, source: "" };
  expect(
    textSelectionSummary(empty, parseTextMarkdown("", { style: empty.style }), 0, 0).style,
  ).toEqual(empty.style);
});
