import { describe, expect, it, vi } from "vitest";

import type { TextStyleV2 } from "../../../../src/domain/schema/public";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { textElement } from "../../../fixtures/rendering/text";

const style: TextStyleV2 = { ...textElement().style, fontSize: 20, opacity: 1 };

function fixture(source: string, width = 200) {
  const measure = {
    measure: vi.fn((text: string, font: TextStyleV2) => ({
      width: Array.from(text).length * font.fontSize * 0.5,
      ascent: font.fontSize * 0.8,
      descent: font.fontSize * 0.2,
    })),
  };
  return {
    request: { document: parseTextMarkdown(source, { style }), width, style },
    measure,
    scheduler: createTestWorkScheduler(),
  };
}

describe("portable Markdown table layout", () => {
  it("reserves matching field and table insets before a following paragraph", async () => {
    const value = fixture("| H |\n| --- |\n| body |\nafter", 200);
    const result = await layoutTextMarkdown({ ...value.request, padding: 28 }, value);
    const table = result.layout.tables![0]!;
    const paragraph = result.layout.lines.find((line) =>
      line.runs.some((run) => run.text === "after"),
    )!;
    expect(paragraph.y - table.y - table.height).toBe(28);
    expect(table.x).toBe(28);
    expect(value.request.width - table.x - table.width).toBe(28);
    expect(result.height - paragraph.y - paragraph.height).toBe(28);
  });
  it("fills the padded field with equal-width columns and preserves source alignment", async () => {
    const source = "| Left | Mid | End |\n| :--- | :---: | ---: |\n| A | B | C |";
    const value = fixture(source, 320);
    const result = await layoutTextMarkdown({ ...value.request, padding: 10 }, value);
    expect(result.layout.tables).toMatchObject([
      { start: 0, end: source.length, x: 10, y: 10, width: 300, columns: 3 },
    ]);
    const body = result.layout.lines.slice(3);
    expect(body.map((line) => line.x)).toEqual([15, 155, 295]);
    expect(body.map((line) => line.width)).toEqual([10, 10, 10]);
    for (const [column, text] of ["A", "B", "C"].entries()) {
      expect(body[column]!.runs[0]).toMatchObject({
        text,
        start: source.lastIndexOf(text),
        end: source.lastIndexOf(text) + 1,
      });
    }
    const table = result.layout.tables![0]!;
    expect(table.x + table.width).toBe(310);
    expect(result.height).toBe(table.height + 20);
  });

  it("wraps within cells, advances by the tallest cell and positions following paragraphs below", async () => {
    const source = "| H | J |\n| --- | --- |\n| abcdefghij | x |\n| tail | y |\n\nafter";
    const value = fixture(source);
    const result = await layoutTextMarkdown(value.request, value);
    const table = result.layout.tables![0]!;
    expect(table.rowHeights).toEqual([36, 62, 36]);
    const lines = result.layout.lines;
    expect(lines.slice(2, 4).map((line) => line.runs.map((run) => run.text).join(""))).toEqual([
      "abcdefghi",
      "j",
    ]);
    expect(lines[4]).toMatchObject({ x: 105, y: 41, width: 10 });
    expect(lines[5]).toMatchObject({ x: 5, y: 103 });
    const paragraph = lines.find((line) => line.runs.some((run) => run.text === "after"))!;
    expect(paragraph.y).toBeGreaterThanOrEqual(table.y + table.height);
    expect(result.height).toBe(paragraph.y + paragraph.height);
    expect(
      lines.slice(2, 5).every((line) => line.x + line.width <= (line.x < 100 ? 95 : 195)),
    ).toBe(true);
  });

  it("reflows narrow columns without scaling fonts or changing source content", async () => {
    const value = fixture("| H | J |\n| --- | --- |\n| abcdefghij | x |");
    const wide = await layoutTextMarkdown(value.request, value);
    const narrow = await layoutTextMarkdown({ ...value.request, width: 100 }, value);
    const bodyStart = value.request.document.source.indexOf("abcdefghij");
    const body = narrow.layout.lines.filter((line) =>
      line.runs.some((run) => run.start >= bodyStart),
    );
    expect(body.slice(0, 3).map((line) => line.runs.map((run) => run.text).join(""))).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
    expect(narrow.layout.tables![0]!.width).toBe(100);
    expect(narrow.layout.tables![0]!.rowHeights[1]).toBe(88);
    expect(narrow.height).toBeGreaterThan(wide.height);
    expect(
      narrow.layout.lines.flatMap((line) => line.runs).every((run) => run.style?.fontSize === 20),
    ).toBe(true);
    expect(
      body
        .slice(0, 3)
        .flatMap((line) => line.runs)
        .map((run) => [run.start, run.end]),
    ).toEqual([
      [bodyStart, bodyStart + 4],
      [bodyStart + 4, bodyStart + 8],
      [bodyStart + 8, bodyStart + 10],
    ]);
  });
});

describe("portable table content and cancellation", () => {
  it("inherits bold headers while honoring explicit overrides and inline Markdown in cells", async () => {
    const source = "| Plain Bold | Other |\n| --- | --- |\n| *em* | `code` |";
    const value = fixture(source, 400);
    const start = source.indexOf("Plain");
    const document = parseTextMarkdown(source, {
      style,
      ranges: [{ start, end: start + 5, style: { bold: false } }],
    });
    const result = await layoutTextMarkdown({ ...value.request, document }, value);
    const runs = result.layout.lines.flatMap((line) => line.runs);
    expect(runs.find((run) => run.text === "Plain")!.style?.bold).toBe(false);
    expect(runs.find((run) => run.text.trim() === "Bold")!.style?.bold).toBe(true);
    expect(runs.find((run) => run.text === "Other")!.style?.bold).toBe(true);
    expect(runs.find((run) => run.text === "em")!.style).toMatchObject({
      italic: true,
      bold: false,
    });
    expect(runs.find((run) => run.text === "code")!.style).toMatchObject({
      fontFamily: "jetbrains-mono",
      bold: false,
    });
  });

  it("resolves inline math against the cell content width and includes its height in the row", async () => {
    const source = "| H | J |\n| --- | --- |\n| **A** $x$ | $y$ |";
    const value = fixture(source, 220);
    const math = {
      resolve: vi.fn(async () => ({
        width: 30,
        height: 40,
        ascent: 30,
        descent: 10,
        paths: [{ d: "M0 0L30 40Z" }],
      })),
    };
    const result = await layoutTextMarkdown({ ...value.request, padding: 10 }, { ...value, math });
    expect(math.resolve.mock.calls).toEqual([
      ["x", false, 20, undefined, 90, { bold: false }],
      ["y", false, 20, undefined, 90, { bold: false }],
    ]);
    expect(result.layout.math).toMatchObject([
      { start: source.indexOf("$x$"), x: 35, y: 51, width: 30, height: 40 },
      { start: source.indexOf("$y$"), x: 115, y: 51, width: 30, height: 40 },
    ]);
    expect(result.layout.tables![0]!.rowHeights).toEqual([36, 50]);
  });

  it("retains empty and omitted cells as aligned columns with a nonzero row height", async () => {
    const value = fixture("| A | B | C |\n| --- | --- | --- |\n| | value |\n| | | |", 300);
    const result = await layoutTextMarkdown(value.request, value);
    expect(result.layout.tables![0]!.rowHeights).toEqual([36, 36, 36]);
    expect(result.layout.lines).toHaveLength(9);
    const body = result.layout.lines.slice(3);
    expect(body.map((line) => line.x)).toEqual([5, 105, 205, 5, 105, 205]);
    expect(body.map((line) => line.runs.map((run) => run.text).join(""))).toEqual([
      "",
      "value",
      "",
      "",
      "",
      "",
    ]);
    expect(body.slice(3).every((line) => line.y === 77)).toBe(true);
  });

  it("cancels table-cell work before further native measurements without publishing partial output", async () => {
    const value = fixture("| H | J |\n| --- | --- |\n| first | second |\n| third | fourth |");
    const abort = new AbortController();
    value.measure.measure.mockImplementation((text, font) => {
      if (text === "first") abort.abort();
      return { width: text.length * 10, ascent: font.fontSize * 0.8, descent: font.fontSize * 0.2 };
    });
    await expect(
      layoutTextMarkdown(value.request, { ...value, signal: abort.signal }),
    ).rejects.toThrow();
    expect(value.measure.measure.mock.calls.some(([text]) => text === "first")).toBe(true);
    expect(value.measure.measure.mock.calls.some(([text]) => text === "second")).toBe(false);
  });
});
