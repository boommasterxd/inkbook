import { describe, expect, it, vi } from "vitest";

import type { TextStyleV2 } from "../../../../src/domain/schema/public";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { formatTextMarkdownStyle } from "../../../../src/domain/text/text-mark-formatting";

const style: TextStyleV2 = {
  fontFamily: "inter",
  fontSize: 20,
  color: { type: "theme-text" },
  opacity: 1,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
};

function fixture(
  source: string,
  width = 100,
  alignment: "left" | "center" | "right" | "justify" = "left",
) {
  const document = parseTextMarkdown(source, { style, paragraphs: [{ start: 0, alignment }] });
  const measure = {
    measure: vi.fn((text: string, value: TextStyleV2) => ({
      width: Array.from(text).length * value.fontSize * 0.5,
      ascent: value.fontSize * 0.8,
      descent: value.fontSize * 0.2,
    })),
  };
  return { request: { document, width, style }, measure, scheduler: createTestWorkScheduler() };
}

function listFontFixture(
  regular: { ascent: number; descent: number },
  bold: { ascent: number; descent: number },
) {
  const value = fixture("- **Bold Bold**", 75);
  const regularId = "a".repeat(64);
  const boldId = "b".repeat(64);
  const resolveFontResourceId = (font: TextStyleV2) => (font.bold ? boldId : regularId);
  const measure = {
    resolveFontResourceId,
    measure: vi.fn((text: string, font: TextStyleV2, fontResourceId?: string) => ({
      width: text.length * 10,
      ...(font.bold ? bold : regular),
      fontResourceId: fontResourceId ?? resolveFontResourceId(font),
    })),
  };
  return { ...value, measure, regularId, boldId };
}

it("honors Bold off for one heading word while retaining its heading and other bold text", async () => {
  const source = "# First word last";
  const start = source.indexOf("word");
  const formatted = formatTextMarkdownStyle(
    { source, ranges: [], paragraphs: [] },
    { start, end: start + 4 },
    { mark: "bold", desired: false, base: style },
  );
  expect(formatted).toMatchObject({ source, changes: [], markActive: false });
  const document = parseTextMarkdown(source, {
    style,
    ranges: formatted.stateBeforeChanges.ranges,
  });
  expect(document.blocks[0]).toMatchObject({ kind: "heading", headingLevel: 1 });
  expect(document.blocks[0]!.runs.find((run) => run.text === "word")!.style.bold).toBe(false);
  const value = fixture(source, 1000);
  const layout = await layoutTextMarkdown({ ...value.request, document }, value);
  const runs = layout.layout.lines.flatMap((line) => line.runs);
  expect(runs.find((run) => run.text === "word")!.style).toMatchObject({
    bold: false,
    fontSize: 40,
  });
  expect(
    runs.filter((run) => run.text.trim() && run.text !== "word").every((run) => run.style?.bold),
  ).toBe(true);
});

describe("portable rich text layout", () => {
  it("wraps paragraphs and preserves source offsets through Markdown, code and escapes", async () => {
    const value = fixture("**Hello** `world` \\*", 65);
    const result = await layoutTextMarkdown(value.request, value);
    expect(result.layout.lines.map((line) => line.runs.map((run) => run.text).join(""))).toEqual([
      "Hello ",
      "world ",
      "*",
    ]);
    const runs = result.layout.lines.flatMap((line) => line.runs).filter((run) => run.text.trim());
    expect(runs[0]).toMatchObject({ start: 2, end: 7, style: { bold: true } });
    expect(runs[1]).toMatchObject({ start: 11, end: 16, style: { fontFamily: "jetbrains-mono" } });
    expect(runs[2]!.end).toBe(value.request.document.source.length);
    expect(result.height).toBe(78);
    expect(
      result.layout.lines.every((line) => line.baseline > 0 && line.baseline <= line.height),
    ).toBe(true);
  });

  it.each(["center", "right"] as const)(
    "applies %s alignment against the field width",
    async (alignment) => {
      const value = fixture("abc", 100, alignment);
      const result = await layoutTextMarkdown(value.request, value);
      expect(result.layout.lines[0]!.x).toBe(alignment === "center" ? 35 : 70);
      expect(result.layout.lines[0]!.width).toBe(30);
    },
  );

  it("justifies wrapped lines by distributing spaces and leaves the final line left aligned", async () => {
    const value = fixture("aa bb cc dd", 85, "justify");
    const result = await layoutTextMarkdown(value.request, value);
    const [first, last] = result.layout.lines;
    expect(first!.width).toBe(85);
    expect(first!.runs.filter((run) => run.text === " ").map((run) => run.width)).toEqual([
      12.5, 12.5,
    ]);
    expect(last).toMatchObject({ x: 0, width: 30 });
    expect(last!.runs.map((run) => run.text).join("")).toBe(" dd");
  });

  it("lays out headings, blank paragraphs, nested list markers and long grapheme clusters", async () => {
    const value = fixture("# Big\n\n  3. abcdefghijklmnop\n\n🙂🙂🙂🙂", 70);
    const result = await layoutTextMarkdown(value.request, value);
    expect(result.layout.lines[0]!.runs[0]!.style).toMatchObject({ fontSize: 40, bold: true });
    expect(result.layout.lines.some((line) => line.runs.length === 0)).toBe(true);
    const list = result.layout.lines.find((line) => line.runs[0]?.text === "3.")!;
    expect(list.x).toBe(60);
    expect(list.runs[0]!.x).toBeLessThan(0);
    expect(
      result.layout.lines
        .flatMap((line) => line.runs)
        .filter((run) => run.text.includes("🙂"))
        .map((run) => run.text)
        .join(""),
    ).toBe("🙂🙂🙂🙂");
  });
});

describe("source line alignment in portable layout", () => {
  it("aligns explicit Enter lines independently without adding a vertical gap", async () => {
    const value = fixture("eins\nzwei", 100);
    value.request.document = parseTextMarkdown("eins\nzwei", {
      style,
      paragraphs: [{ start: 5, alignment: "right" }],
    });
    const result = await layoutTextMarkdown(value.request, value);
    expect(result.layout.lines.map((line) => ({ x: line.x, y: line.y }))).toEqual([
      { x: 0, y: 0 },
      { x: 60, y: 26 },
    ]);
    expect(result.height).toBe(52);
  });

  it("keeps automatic wraps on the same source line aligned together", async () => {
    const source = "eins eins\nzwei zwei";
    const value = fixture(source, 60);
    value.request.document = parseTextMarkdown(source, {
      style,
      paragraphs: [{ start: 10, alignment: "right" }],
    });
    const result = await layoutTextMarkdown(value.request, value);
    expect(result.layout.lines.map((line) => line.x)).toEqual([0, 0, 10, 20]);
    expect(result.layout.lines.map((line) => line.y)).toEqual([0, 26, 52, 78]);
    expect(result.height).toBe(104);
  });

  it("retains multiline marks and CRLF blank line height while aligning source lines", async () => {
    const source = "**eins\r\nzwei**\r\n\r\ndrei";
    const value = fixture(source, 100);
    value.request.document = parseTextMarkdown(source, {
      style,
      paragraphs: [
        { start: 8, alignment: "right" },
        { start: 16, alignment: "left" },
      ],
    });
    const result = await layoutTextMarkdown(value.request, value);
    expect(result.layout.lines.slice(0, 2).map((line) => line.x)).toEqual([0, 60]);
    expect(
      result.layout.lines.slice(0, 2).every((line) => line.runs.every((run) => run.style?.bold)),
    ).toBe(true);
    expect(result.layout.lines.map((line) => line.y)).toEqual([0, 26, 52, 78]);
    expect(result.height).toBe(104);
  });
});

describe("rich text math and resource limits", () => {
  it("resolves inline and display math to field-local baseline geometry", async () => {
    const value = fixture("A $x^2$ B\n\n$$x=1$$", 200);
    const math = {
      resolve: vi.fn(async () => ({
        width: 30,
        height: 35,
        ascent: 27,
        descent: 8,
        paths: [{ d: "M0 0L30 35Z" }],
      })),
    };
    const result = await layoutTextMarkdown(value.request, { ...value, math });
    expect(math.resolve.mock.calls).toHaveLength(2);
    expect(result.layout.math?.map((entry) => entry.display)).toEqual([false, true]);
    expect(result.layout.math?.[0]).toMatchObject({
      start: 2,
      end: 7,
      x: 20,
      y: 0,
      width: 30,
      height: 35,
    });
    expect(result.layout.lines[0]!.height).toBe(35);
    expect(result.layout.lines[0]!.runs.map((run) => run.text).join("")).toBe("A  B");
  });

  it("cancels stale work before further native measurements and never publishes a partial layout", async () => {
    const value = fixture("word ".repeat(500));
    const abort = new AbortController();
    let reads = 0;
    value.measure.measure.mockImplementation((text, font) => {
      if (++reads === 3) abort.abort();
      return { width: text.length * 10, ascent: font.fontSize, descent: 0 };
    });
    await expect(
      layoutTextMarkdown(value.request, { ...value, signal: abort.signal }),
    ).rejects.toThrow();
    expect(reads).toBe(3);
  });

  it("bounds individual native measurements for a maximum-size unbroken source", async () => {
    const value = fixture("a".repeat(100_000), 1000);
    const result = await layoutTextMarkdown(value.request, value);
    expect(result.layout.lines.length).toBeGreaterThan(900);
    expect(
      Math.max(...value.measure.measure.mock.calls.map(([text]) => text.length)),
    ).toBeLessThanOrEqual(256);
    expect(value.measure.measure.mock.calls.length).toBeLessThan(15_000);
  });
});

describe("portable text strut faces", () => {
  it("uses the actual bold glyph face without resolving or measuring an unused regular strut", async () => {
    const value = fixture("**Bold**", 200);
    const boldId = "b".repeat(64);
    let regularAvailable = true;
    const resolveFontResourceId = vi.fn((font: TextStyleV2) => {
      if (!font.bold && !regularAvailable) throw new Error("Regular face removed.");
      return font.bold ? boldId : "a".repeat(64);
    });
    const measure = {
      resolveFontResourceId,
      measure: vi.fn((text: string, font: TextStyleV2, fontResourceId?: string) => {
        const id = fontResourceId ?? resolveFontResourceId(font);
        return {
          width: text.length * 10,
          ascent: id === boldId ? 8 : 18,
          descent: id === boldId ? 12 : 2,
          fontResourceId: id,
        };
      }),
    };
    const ports = { ...value, measure };
    const initial = await layoutTextMarkdown(value.request, ports);
    expect(initial).toMatchObject({
      height: 26,
      layout: { baseFontResourceId: boldId, lines: [{ baseline: 11, height: 26, width: 40 }] },
    });
    expect(resolveFontResourceId.mock.calls.every(([font]) => font.bold)).toBe(true);
    regularAvailable = false;
    expect(await layoutTextMarkdown(value.request, ports)).toEqual(initial);
    expect(
      measure.measure.mock.calls.every(([_text, font, id]) => font.bold && id === boldId),
    ).toBe(true);
  });

  it("keeps blank-block size and flags while borrowing the first document glyph's bound face", async () => {
    const value = fixture("\n# Title", 200);
    const boldId = "b".repeat(64);
    const queries = vi.fn((font: TextStyleV2) => {
      if (!font.bold) throw new Error("Unused regular face requested.");
      return boldId;
    });
    const measure = {
      resolveFontResourceId: queries,
      measure: vi.fn((text: string, font: TextStyleV2, fontResourceId?: string) => ({
        width: text.length * font.fontSize * 0.5,
        ascent: font.fontSize * 0.8,
        descent: font.fontSize * 0.2,
        ...(fontResourceId === undefined ? {} : { fontResourceId }),
      })),
    };
    const result = await layoutTextMarkdown(value.request, { ...value, measure });
    expect(result.layout.baseFontResourceId).toBe(boldId);
    expect(result.layout.lines.map((line) => line.height)).toEqual([26, 52]);
    const [text, strutStyle, faceId] = measure.measure.mock.calls[0]!;
    expect(text).toBe("");
    expect(strutStyle.fontSize).toBe(20);
    expect(strutStyle.bold).toBe(false);
    expect(faceId).toBe(boldId);
    expect(queries.mock.calls.every(([font]) => font.bold)).toBe(true);
  });

  it.each(["", "$x$"])("keeps an explicit base face without glyph hints for %j", async (source) => {
    const value = fixture(source, 200);
    const baseFontResourceId = "c".repeat(64);
    const resolveFontResourceId = vi.fn(() => {
      throw new Error("Removed logical family must not be resolved.");
    });
    const measure = {
      resolveFontResourceId,
      measure: vi.fn((text: string, font: TextStyleV2, fontResourceId?: string) => ({
        width: text.length * 10,
        ascent: font.fontSize * 0.8,
        descent: font.fontSize * 0.2,
        ...(fontResourceId === undefined ? {} : { fontResourceId }),
      })),
    };
    const math = {
      resolve: async () => ({
        width: 20,
        height: 20,
        ascent: 15,
        descent: 5,
        paths: [{ d: "M0 0L20 20Z" }],
      }),
    };
    const result = await layoutTextMarkdown(
      { ...value.request, baseFontResourceId },
      { ...value, measure, math },
    );
    expect(result.layout.baseFontResourceId).toBe(baseFontResourceId);
    expect(resolveFontResourceId).not.toHaveBeenCalled();
    expect(measure.measure.mock.calls[0]![2]).toBe(baseFontResourceId);
  });
});

describe("list marker line boxes", () => {
  it("includes a taller regular marker only on the first line of a bold list item", async () => {
    const value = listFontFixture({ ascent: 26, descent: 2 }, { ascent: 8, descent: 12 });
    const result = await layoutTextMarkdown(value.request, value);
    const [first, whitespace, continuation] = result.layout.lines;
    expect(result.height).toBe(92);
    expect(first).toMatchObject({ x: 30, y: 0, width: 40, baseline: 25, height: 40 });
    expect(whitespace!.runs.map((run) => run.text).join("")).toBe(" ");
    expect(continuation).toMatchObject({ x: 30, y: 66, width: 40, baseline: 11, height: 26 });
    expect(first!.runs[0]).toMatchObject({
      text: "•",
      x: -17,
      width: 10,
      fontResourceId: value.regularId,
    });
    expect(first!.runs[0]!.style!.bold).toBe(false);
    expect(first!.runs[1]).toMatchObject({
      text: "Bold",
      x: 0,
      width: 40,
      fontResourceId: value.boldId,
    });
    expect(continuation!.runs).toHaveLength(1);
    expect(result.layout.baseFontResourceId).toBe(value.boldId);
    expect(value.measure.measure.mock.calls.filter(([text]) => text === "•")).toHaveLength(1);
    // The same CSS line boxes used by the native editor lie inside the exported field.
    expect(first!.baseline - 25).toBe(0);
    expect(first!.baseline + 15).toBe(first!.height);
  });

  it("preserves standard-font dimensions, indentation, marker width and exact face IDs", async () => {
    const value = listFontFixture({ ascent: 16, descent: 4 }, { ascent: 16, descent: 4 });
    const result = await layoutTextMarkdown(value.request, value);
    expect(result.height).toBe(78);
    expect(
      result.layout.lines.map((line) => ({
        x: line.x,
        width: line.width,
        baseline: line.baseline,
        height: line.height,
      })),
    ).toEqual([
      { x: 30, width: 40, baseline: 19, height: 26 },
      { x: 30, width: 10, baseline: 19, height: 26 },
      { x: 30, width: 40, baseline: 19, height: 26 },
    ]);
    expect(result.layout.lines[0]!.runs[0]).toMatchObject({
      x: -17,
      width: 10,
      fontResourceId: value.regularId,
    });
    expect(result.layout.lines[0]!.runs[1]!.fontResourceId).toBe(value.boldId);
    expect(value.measure.measure.mock.calls.filter(([text]) => text === "•")).toHaveLength(1);
  });
});
