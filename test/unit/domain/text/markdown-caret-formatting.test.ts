import { describe, expect, it } from "vitest";
import type { TextMarkdownFormatResult } from "../../../../src/domain/text/markdown-formatting";
import type { TextMarkdownMark } from "../../../../src/domain/text/text-types";
import {
  forceTextMarkdownMark,
  toggleTextMarkdownMark,
  parseTextMarkdown,
} from "../../../fixtures/domain/text-source";
import { textElement } from "../schema/fixtures";

const marks: TextMarkdownMark[] = ["bold", "italic", "strikethrough"];

function caretState(source: string): Pick<TextMarkdownFormatResult, "source" | "selection"> {
  return { source, selection: { start: source.length, end: source.length } };
}

describe("empty source caret marks", () => {
  it.each(["", "# Heading\n\n", "- "])(
    "sets combined typing marks reversibly after %j without introducing literal marker residue",
    (source) => {
      let state = caretState(source);
      for (const desired of [true, false]) {
        for (const mark of marks) {
          const result = forceTextMarkdownMark(state.source, state.selection, mark, desired);
          expect(result.markActive).toBe(desired);
          state = result;
          const satisfied = forceTextMarkdownMark(state.source, state.selection, mark, desired);
          expect(satisfied.changes).toEqual([]);
          expect(satisfied.markActive).toBe(desired);
        }
      }
      expect(state).toMatchObject(caretState(source));
    },
  );

  it("keeps toggle shortcuts reversible and applies every combined mark to the next typed word", () => {
    let state = caretState("");
    for (const mark of marks) state = toggleTextMarkdownMark(state.source, state.selection, mark);
    const typed =
      state.source.slice(0, state.selection.start) +
      "Word" +
      state.source.slice(state.selection.end);
    const document = parseTextMarkdown(typed, { style: textElement().style });
    expect(document.blocks[0]!.runs).toMatchObject([
      { text: "Word", style: { bold: true, italic: true, strikethrough: true } },
    ]);
    for (const mark of marks) state = toggleTextMarkdownMark(state.source, state.selection, mark);
    expect(state).toMatchObject(caretState(""));
  });

  it("removes only the empty inner typing mark while retaining surrounding nonempty source marks", () => {
    const source = "**before ~~~~ after**";
    const caret = source.indexOf("~~~~") + 2;
    const result = forceTextMarkdownMark(
      source,
      { start: caret, end: caret },
      "strikethrough",
      false,
    );
    expect(result.source).toBe("**before  after**");
    expect(result.selection).toEqual({ start: caret - 2, end: caret - 2 });
    expect(result.markActive).toBe(false);
  });

  it("sets a typing gap off idempotently and rejoins it when explicitly enabled", () => {
    const source = "**hello**";
    const off = forceTextMarkdownMark(source, { start: 4, end: 4 }, "bold", false);
    expect(off.source).toBe("**he****llo**");
    expect(forceTextMarkdownMark(off.source, off.selection, "bold", false).changes).toEqual([]);
    const on = forceTextMarkdownMark(off.source, off.selection, "bold", true);
    expect(on).toMatchObject({ source, selection: { start: 4, end: 4 }, markActive: true });
  });

  it("returns the active mark state after rejoining a typing gap inside combined source marks", () => {
    const source = "***~~Write~~***";
    const off = toggleTextMarkdownMark(source, { start: 10, end: 10 }, "bold");
    const on = toggleTextMarkdownMark(off.source, off.selection, "bold");
    expect(on).toMatchObject({ source, selection: { start: 10, end: 10 }, markActive: true });
  });
});
