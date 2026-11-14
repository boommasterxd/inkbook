import { describe, expect, it } from "vitest";

import { MAX_TEXT_SOURCE_LENGTH } from "../../../../src/domain/schema/public";
import {
  toggleTextMarkdownMark,
  applyTextEdit,
  parseTextMarkdown,
} from "../../../fixtures/domain/text-source";
import {
  applyTextParagraphAlignment,
  applyTextStyleRange,
} from "../../../../src/domain/text/text-source-edits";
import type { TextSourceState } from "../../../../src/domain/text/text-types";

describe("text source formatting and edits", () => {
  it("removes only the selected mark while retaining nested independent syntax", () => {
    const source = "**bold *italic* end**";
    const result = toggleTextMarkdownMark(source, { start: 0, end: source.length }, "bold");
    expect(result.source).toBe("bold *italic* end");
    expect(result.selection).toEqual({ start: 0, end: result.source.length });
    expect(toggleTextMarkdownMark("***both***", { start: 3, end: 7 }, "bold").source).toBe(
      "*both*",
    );
  });

  it("splits an existing marked run and applies a single source mark to a mixed selection", () => {
    const removed = toggleTextMarkdownMark("**hello world**", { start: 2, end: 7 }, "bold");
    expect(removed.source).toBe("hello** world**");
    expect(removed.selection).toEqual({ start: 0, end: 5 });
    expect(toggleTextMarkdownMark("a **b** c", { start: 0, end: 9 }, "bold").source).toBe(
      "**a b c**",
    );
    expect(toggleTextMarkdownMark("code ` value", { start: 0, end: 12 }, "code").source).toBe(
      "``code ` value``",
    );
  });

  it("inserts paired syntax at a caret and keeps the caret inside it", () => {
    expect(toggleTextMarkdownMark("hello", { start: 5, end: 5 }, "italic")).toMatchObject({
      source: "hello**",
      selection: { start: 6, end: 6 },
    });
  });

  it("formats across distinct Markdown paragraphs without wrapping their block syntax", () => {
    const source = "# title\n\n- item\n\nparagraph";
    expect(toggleTextMarkdownMark(source, { start: 0, end: source.length }, "bold").source).toBe(
      "# **title**\n\n- **item**\n\n**paragraph**",
    );
    const mixed = toggleTextMarkdownMark("*hello world*", { start: 1, end: 6 }, "bold");
    expect(mixed.source).toBe("***hello** world*");
  });

  it("rebases independent styles after insertion, replacement and deletion", () => {
    const initial: TextSourceState = {
      source: "hello\nworld",
      ranges: [
        { start: 0, end: 5, style: { underline: true } },
        { start: 6, end: 11, style: { opacity: 0.5 } },
      ],
      paragraphs: [
        { start: 0, alignment: "center" },
        { start: 6, alignment: "right" },
      ],
    };
    const inserted = applyTextEdit(initial, { start: 3, end: 3, insert: "!!" });
    expect(inserted.ranges.map(({ start, end }) => [start, end])).toEqual([
      [0, 7],
      [8, 13],
    ]);
    expect(inserted.paragraphs.map(({ start }) => start)).toEqual([0, 8]);
    const replaced = applyTextEdit(inserted, { start: 0, end: 7, insert: "new" });
    expect(replaced.ranges[0]).toMatchObject({ start: 0, end: 3, style: { underline: true } });
    const deleted = applyTextEdit(replaced, { start: 0, end: 4, insert: "" });
    expect(deleted.source).toBe("world");
    expect(deleted.ranges).toEqual([{ start: 0, end: 5, style: { opacity: 0.5 } }]);
    expect(deleted.paragraphs).toEqual([{ start: 0, alignment: "right" }]);
  });

  it("applies selected independent styles and limits alignment to selected paragraphs", () => {
    const state: TextSourceState = { source: "one\n\ntwo\n\nthree", ranges: [], paragraphs: [] };
    const styled = applyTextStyleRange(
      state,
      { start: 0, end: 3 },
      { fontSize: 24, underline: true },
    );
    expect(styled.ranges).toEqual([{ start: 0, end: 3, style: { fontSize: 24, underline: true } }]);
    expect(state.ranges).toEqual([]);
    const aligned = applyTextParagraphAlignment(styled, { start: 5, end: 8 }, "justify");
    expect(aligned.paragraphs).toEqual([
      { start: 5, alignment: "justify" },
      { start: 9, alignment: "left" },
    ]);
    expect(() => applyTextEdit(state, { start: -1, end: 0, insert: "" })).toThrow(RangeError);
  });
});

describe("text source formatting capacity", () => {
  it("toggles typing out of an active source mark without changing other text", () => {
    expect(toggleTextMarkdownMark("**hello**", { start: 4, end: 4 }, "bold")).toMatchObject({
      source: "**he****llo**",
      selection: { start: 6, end: 6 },
    });
    expect(toggleTextMarkdownMark("**hello**", { start: 2, end: 2 }, "bold")).toMatchObject({
      source: "**hello**",
      selection: { start: 0, end: 0 },
      changes: [],
    });
    expect(toggleTextMarkdownMark("**hello**", { start: 7, end: 7 }, "bold")).toMatchObject({
      source: "**hello**",
      selection: { start: 9, end: 9 },
      changes: [],
    });
  });

  it("reuses parsed block spans for formatting and rejects a stale parse result", () => {
    const source = "# heading\n\n**bold *both* end**\n\nlast";
    const document = parseTextMarkdown(source, {
      style: {
        fontFamily: "sans",
        fontSize: 20,
        color: { type: "theme-text" },
        opacity: 1,
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
      },
      ranges: [{ start: 14, end: 17, style: { underline: true } }],
    });
    const selection = { start: 11, end: 28 };
    expect(toggleTextMarkdownMark(source, selection, "bold", document)).toEqual(
      toggleTextMarkdownMark(source, selection, "bold"),
    );
    expect(toggleTextMarkdownMark("other", { start: 0, end: 5 }, "bold", document).source).toBe(
      "**other**",
    );
  });

  it("compacts repeated styling without losing unrelated independent properties", () => {
    const state: TextSourceState = { source: "abcd", ranges: [], paragraphs: [] };
    const first = applyTextStyleRange(
      state,
      { start: 0, end: 4 },
      { color: { type: "rgba", value: "#ff0000" }, underline: true },
    );
    const second = applyTextStyleRange(first, { start: 1, end: 3 }, { fontSize: 30 });
    const final = applyTextStyleRange(second, { start: 0, end: 4 }, { fontSize: 20 });
    expect(final.ranges).toEqual([
      {
        start: 0,
        end: 4,
        style: { color: { type: "rgba", value: "#ff0000" }, underline: true, fontSize: 20 },
      },
    ]);
    expect(applyTextStyleRange(final, { start: 1, end: 1 }, { fontSize: 30 })).toBe(final);
    expect(
      applyTextParagraphAlignment({ ...state, source: "one\ntwo" }, { start: 5, end: 7 }, "right")
        .paragraphs,
    ).toEqual([{ start: 4, alignment: "right" }]);
  });

  it("rejects edits and formatting beyond the validated source capacity atomically", () => {
    const state: TextSourceState = {
      source: "x".repeat(MAX_TEXT_SOURCE_LENGTH),
      ranges: [],
      paragraphs: [],
    };
    expect(() => applyTextEdit(state, { start: 0, end: 0, insert: "x" })).toThrow(RangeError);
    expect(() =>
      toggleTextMarkdownMark(state.source, { start: 0, end: state.source.length }, "bold"),
    ).toThrow(RangeError);
    expect(state.source).toHaveLength(MAX_TEXT_SOURCE_LENGTH);
  });
});
