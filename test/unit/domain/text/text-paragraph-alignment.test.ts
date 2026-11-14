import { describe, expect, it } from "vitest";

import { textBlockAlignmentAt } from "../../../../src/domain/text/text-paragraph-alignment";
import { applyTextParagraphAlignment } from "../../../../src/domain/text/text-source-edits";
import type { TextSourceState } from "../../../../src/domain/text/text-types";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { textElement } from "../schema/fixtures";

describe("explicit source line alignment", () => {
  it("aligns only the second Enter-created line while retaining one Markdown parsing group", () => {
    const state: TextSourceState = { source: "eins\nzwei", ranges: [], paragraphs: [] };
    const next = applyTextParagraphAlignment(state, { start: 7, end: 7 }, "right");
    expect(next.paragraphs).toEqual([{ start: 5, alignment: "right" }]);
    const document = parseTextMarkdown(next.source, {
      style: textElement().style,
      paragraphs: next.paragraphs,
    });
    expect(document.blocks).toHaveLength(1);
    expect(textBlockAlignmentAt(document.blocks[0]!, 4)).toBe("left");
    expect(textBlockAlignmentAt(document.blocks[0]!, 5)).toBe("right");
  });

  it("retains multiline Markdown marks and their hidden source offsets", () => {
    const source = "**eins\nzwei**";
    const next = applyTextParagraphAlignment(
      { source, ranges: [], paragraphs: [] },
      { start: 8, end: 8 },
      "center",
    );
    const document = parseTextMarkdown(source, {
      style: textElement().style,
      paragraphs: next.paragraphs,
    });
    const baseline = parseTextMarkdown(source, { style: textElement().style });
    expect(document.spans).toEqual(baseline.spans);
    expect(document.blocks[0]!.runs).toEqual(baseline.blocks[0]!.runs);
    expect(document.blocks[0]!.runs[0]).toMatchObject({
      contentStart: 2,
      contentEnd: 11,
      style: { bold: true },
    });
    expect(textBlockAlignmentAt(document.blocks[0]!, 6)).toBe("left");
    expect(textBlockAlignmentAt(document.blocks[0]!, 7)).toBe("center");
  });

  it("includes selected blank CRLF lines and excludes the line where a selection ends", () => {
    const state: TextSourceState = {
      source: "eins\r\n\r\nzwei\r\ndrei",
      ranges: [],
      paragraphs: [],
    };
    expect(applyTextParagraphAlignment(state, { start: 6, end: 14 }, "right").paragraphs).toEqual([
      { start: 6, alignment: "right" },
      { start: 8, alignment: "right" },
      { start: 14, alignment: "left" },
    ]);
    expect(applyTextParagraphAlignment(state, { start: 0, end: 6 }, "center").paragraphs).toEqual([
      { start: 0, alignment: "center" },
      { start: 6, alignment: "left" },
    ]);
    expect(
      applyTextParagraphAlignment(
        { ...state, paragraphs: [{ start: 0, alignment: "center" }] },
        { start: 6, end: 6 },
        "right",
      ).paragraphs,
    ).toEqual([
      { start: 0, alignment: "center" },
      { start: 6, alignment: "right" },
      { start: 8, alignment: "center" },
    ]);
  });

  it("keeps headings, lists and multiline display math grouped as before", () => {
    const source = "# Heading\n- item\n  2. nested\n\n$$\na+b\n$$";
    const next = applyTextParagraphAlignment(
      { source, ranges: [], paragraphs: [] },
      { start: source.indexOf("a+b"), end: source.indexOf("a+b") },
      "right",
    );
    const document = parseTextMarkdown(source, {
      style: textElement().style,
      paragraphs: next.paragraphs,
    });
    expect(document.blocks.map((block) => block.kind)).toEqual([
      "heading",
      "list-item",
      "list-item",
      "paragraph",
      "math",
    ]);
    expect(document.blocks[document.blocks.length - 1]!.runs[0]!.latex).toBe("a+b");
  });
});
