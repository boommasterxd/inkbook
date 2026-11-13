import { describe, expect, it } from "vitest";

import { parseTextMarkdownSteps } from "../../../../src/domain/text/markdown-parser";
import type { TextMarkdownBlock } from "../../../../src/domain/text/text-types";
import { textElement } from "../schema/fixtures";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";

const style = textElement().style;
const cellText = (source: string, block: TextMarkdownBlock) =>
  block.table!.rows.map((row) =>
    row.cells.map((cell) => source.slice(cell.contentStart, cell.contentEnd)),
  );

describe("Markdown pipe tables", () => {
  it("interrupts paragraphs and retains CRLF/UTF-16 ranges, column alignment, and following blocks", () => {
    const source =
      "Before\r\n| 😀 Name | Value | Result |\r\n| :--- | :---: | ---: |\r\n| A | B | C |\r\nAfter\r\n# Heading";
    const document = parseTextMarkdown(source, { style });
    expect(document.blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "table",
      "paragraph",
      "heading",
    ]);
    const block = document.blocks[1]!;
    expect(block.table!.alignments).toEqual(["left", "center", "right"]);
    expect(source.slice(block.table!.delimiter.start, block.table!.delimiter.end)).toBe(
      "| :--- | :---: | ---: |",
    );
    expect(source.slice(block.start, block.end)).toBe(
      "| 😀 Name | Value | Result |\r\n| :--- | :---: | ---: |\r\n| A | B | C |",
    );
    expect(cellText(source, block)).toEqual([
      ["😀 Name", "Value", "Result"],
      ["A", "B", "C"],
    ]);
    expect(source.slice(block.runs[0]!.start, block.runs[0]!.end)).toBe("😀 Name");
  });

  it("parses each cell inline with independent marks, literal escaped pipes, and exact backtick runs", () => {
    const source = "Name | Value\n--- | ---\n**a** \\| b | ``a ` | b``\n`unmatched | *end*";
    const document = parseTextMarkdown(source, { style });
    const block = document.blocks[0]!;
    expect(cellText(source, block)).toEqual([
      ["Name", "Value"],
      ["**a** \\| b", "``a ` | b``"],
      ["`unmatched", "*end*"],
    ]);
    expect(block.runs.map((run) => run.text).join("")).toBe("NameValuea | ba ` | b`unmatchedend");
    expect(block.runs.find((run) => run.code)?.text).toBe("a ` | b");
    expect(block.runs.find((run) => run.text === "end")?.style.italic).toBe(true);
    expect(document.spans.map((span) => source.slice(span.start, span.end))).toEqual([
      "**a**",
      "``a ` | b``",
      "*end*",
    ]);
    expect(block.table!.rows.every((row) => row.cells.every((cell) => !("runs" in cell)))).toBe(
      true,
    );
  });

  it("applies header defaults before explicit source styles and preserves paragraph alignment anchors", () => {
    const source = "A | B\n--- | ---:\na | b";
    const body = source.lastIndexOf("a");
    const block = parseTextMarkdown(source, {
      style,
      ranges: [{ start: 0, end: 1, style: { bold: false, underline: true } }],
      paragraphs: [
        { start: 0, alignment: "center" },
        { start: body, alignment: "right" },
      ],
    }).blocks[0]!;
    expect(block.alignment).toBe("center");
    expect(block.sourceAlignments).toEqual([{ start: body, alignment: "right" }]);
    expect(block.runs[0]!.style).toMatchObject({ bold: false, underline: true });
    expect(block.runs[1]!.style.bold).toBe(true);
    expect(block.runs[2]!.style.bold).toBe(false);
  });

  it("pads missing cells, ignores excess body cells, and preserves empty cells", () => {
    const source = "| A | B | C |\n| --- | --- | --- |\n| one |\n| a |  | c | ignored |";
    const block = parseTextMarkdown(source, { style }).blocks[0]!;
    expect(cellText(source, block)).toEqual([
      ["A", "B", "C"],
      ["one", "", ""],
      ["a", "", "c"],
    ]);
    expect(block.runs.map((run) => run.text)).toEqual(["A", "B", "C", "one", "a", "c"]);
    const missing = block.table!.rows[1]!;
    expect(missing.cells[1]).toEqual({
      start: missing.end,
      end: missing.end,
      contentStart: missing.end,
      contentEnd: missing.end,
    });
    expect(parseTextMarkdown("| A |\n| --- |", { style }).blocks[0]!.table!.alignments).toEqual([
      "left",
    ]);
  });

  it("retains malformed delimiters and mismatched headers as normal text", () => {
    for (const source of [
      "A | B\n--- | --",
      "A | B\n--- | --- | ---",
      "A \\| B\n--- | ---",
      "`A | B`\n--- | ---",
    ]) {
      const document = parseTextMarkdown(source, { style });
      expect(document.blocks.every((block) => block.kind === "paragraph")).toBe(true);
      expect(document.blocks.some((block) => block.table)).toBe(false);
    }
  });
});

describe("resumable Markdown table parsing", () => {
  it("retains admission checkpoints for a large table", () => {
    const source = "A | B\n--- | ---\n" + "left | right\n".repeat(3000);
    const steps = parseTextMarkdownSteps(source, { style });
    for (let checkpoint = 0; checkpoint <= 3000; checkpoint += 1)
      expect(steps.next().done).toBe(false);
    const document = finishGeometrySteps(steps);
    expect(document.blocks[0]!.table!.rows).toHaveLength(3001);
    expect(document.blocks[0]!.runs).toHaveLength(6002);
  });
});
