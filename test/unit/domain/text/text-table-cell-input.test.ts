import { describe, expect, it } from "vitest";

import { MAX_TEXT_SOURCE_LENGTH } from "../../../../src/domain/schema/public";
import { textTableCellInputChanges } from "../../../../src/domain/text/text-table-cell-input";
import { applyTextEditsSteps } from "../../../../src/domain/text/text-source-edits";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { textElement } from "../schema/fixtures";

function normalizeCell(source: string): string {
  return finishGeometrySteps(
    applyTextEditsSteps({ source, ranges: [], paragraphs: [] }, textTableCellInputChanges(source)),
  ).source;
}

describe("Markdown table cell input", () => {
  it("preserves ordinary input and escapes literal pipes without double-escaping source or LaTeX", () => {
    expect(normalizeCell("ordinary 😀 text")).toBe("ordinary 😀 text");
    expect(normalizeCell("")).toBe("");
    expect(normalizeCell("a | b | c")).toBe("a \\| b \\| c");
    const latex = String.raw`$\|x\|$ and \| literal and \\| delimiter`;
    expect(normalizeCell(latex)).toBe(String.raw`$\|x\|$ and \| literal and \\\| delimiter`);
  });

  it("preserves pipes in complete code spans with exact delimiter lengths", () => {
    expect(normalizeCell("`a | b` | ``x ` | y``")).toBe("`a | b` \\| ``x ` | y``");
    expect(normalizeCell("``unmatched | `also unmatched |")).toBe(
      "``unmatched \\| `also unmatched \\|",
    );
    expect(normalizeCell("\\`literal | `unmatched")).toBe("\\`literal \\| `unmatched");
    expect(normalizeCell("``a | ```b | `` tail |")).toBe("``a | ```b | `` tail \\|");
  });

  it("normalizes every newline form while preserving complete code spans", () => {
    expect(normalizeCell("a | b\r\nc\rd\ne")).toBe("a \\| b c d e");
    expect(normalizeCell("`a\n| b`\n| c")).toBe("`a | b` \\| c");
  });

  it("keeps pasted prose and code in one cell through the actual table parser", () => {
    const pasted = "a | b\r\n`x | y` and \\| literal";
    const insert = normalizeCell(pasted);
    const source = `| Header | Next |\n| --- | --- |\n| ${insert} | unchanged |`;
    const table = parseTextMarkdown(source, { style: textElement().style }).blocks[0]!.table!;
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]!.cells).toHaveLength(2);
    const cell = table.rows[1]!.cells[0]!;
    expect(source.slice(cell.contentStart, cell.contentEnd)).toBe(insert);
    const next = table.rows[1]!.cells[1]!;
    expect(source.slice(next.contentStart, next.contentEnd)).toBe("unchanged");
  });

  it("enforces the shared source limit before processing and after pipe escaping", () => {
    const full = "x".repeat(MAX_TEXT_SOURCE_LENGTH);
    expect(normalizeCell(full)).toBe(full);
    expect(() => normalizeCell(full + "x")).toThrow(RangeError);
    expect(() => normalizeCell(full.slice(1) + "|")).toThrow(RangeError);
    expect(normalizeCell("`" + full.slice(3) + "|`")).toHaveLength(MAX_TEXT_SOURCE_LENGTH);
  });

  it("returns only exact normalization edits over the current cell", () => {
    const source = "a | `b | c`\r\nlast \\| pipe";
    const pipe = source.indexOf("|");
    const newline = source.indexOf("\r");
    expect(textTableCellInputChanges(source)).toEqual([
      { start: pipe, end: pipe, insert: "\\" },
      { start: newline, end: newline + 2, insert: " " },
    ]);
    expect(textTableCellInputChanges("ordinary")).toEqual([]);
    expect(textTableCellInputChanges("`code\n| pipe`")).toEqual([
      { start: 5, end: 6, insert: " " },
    ]);
  });
});
