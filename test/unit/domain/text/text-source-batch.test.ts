import { describe, expect, it } from "vitest";

import { MAX_TEXT_SOURCE_LENGTH } from "../../../../src/domain/schema/public";
import { toggleTextMarkdownMark } from "../../../fixtures/domain/text-source";
import {
  applyTextEditsSteps,
  type TextSourceRangeMapper,
} from "../../../../src/domain/text/text-source-edits";
import type { TextSourceChange, TextSourceState } from "../../../../src/domain/text/text-types";

function apply(state: TextSourceState, changes: readonly TextSourceChange[]) {
  const steps = applyTextEditsSteps(state, changes);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

describe("atomic text source batches", () => {
  it("rebases independent styles and alignment once across multiple Markdown delimiters", () => {
    const state: TextSourceState = {
      source: "**one**\n\n**two**",
      ranges: [
        { start: 2, end: 5, style: { underline: true } },
        { start: 11, end: 14, style: { opacity: 0.4 } },
      ],
      paragraphs: [
        { start: 0, alignment: "center" },
        { start: 9, alignment: "right" },
      ],
    };
    const formatted = toggleTextMarkdownMark(
      state.source,
      { start: 0, end: state.source.length },
      "bold",
    );
    const result = apply(state, formatted.changes);
    expect(result).toEqual({
      source: "one\n\ntwo",
      ranges: [
        { start: 0, end: 3, style: { underline: true } },
        { start: 5, end: 8, style: { opacity: 0.4 } },
      ],
      paragraphs: [
        { start: 0, alignment: "center" },
        { start: 5, alignment: "right" },
      ],
    });
    expect(result.source).toBe(formatted.source);
    expect(apply(state, [...formatted.changes].reverse())).toEqual(result);
    expect(state.ranges[0]!.start).toBe(2);
  });

  it("preserves insertion affinity and merged paragraph alignment in one native transaction", () => {
    const state: TextSourceState = {
      source: "one\ntwo\nthree",
      ranges: [{ start: 4, end: 7, style: { fontSize: 30 } }],
      paragraphs: [
        { start: 0, alignment: "center" },
        { start: 4, alignment: "right" },
        { start: 8, alignment: "justify" },
      ],
    };
    const changes = [
      { start: 8, end: 13, insert: "THREE" },
      { start: 3, end: 4, insert: " / " },
      { start: 0, end: 0, insert: "X\n" },
    ];
    expect(apply(state, changes)).toEqual({
      source: "X\none / two\nTHREE",
      ranges: [{ start: 8, end: 11, style: { fontSize: 30 } }],
      paragraphs: [
        { start: 0, alignment: "right" },
        { start: 12, alignment: "justify" },
      ],
    });
    expect(
      apply(
        {
          source: "abcd",
          ranges: [{ start: 0, end: 4, style: { underline: true } }],
          paragraphs: [],
        },
        [
          { start: 2, end: 4, insert: "" },
          { start: 0, end: 2, insert: "" },
        ],
      ).ranges,
    ).toEqual([]);
  });

  it("retains descending-edit paragraph ownership when an earlier insertion meets a collapsed anchor", () => {
    const state: TextSourceState = {
      source: "abc\nD\nE",
      ranges: [],
      paragraphs: [
        { start: 0, alignment: "left" },
        { start: 4, alignment: "center" },
        { start: 6, alignment: "right" },
      ],
    };
    expect(
      apply(state, [
        { start: 5, end: 7, insert: "" },
        { start: 4, end: 4, insert: "\n" },
      ]),
    ).toEqual({
      source: "abc\n\nD",
      ranges: [],
      paragraphs: [
        { start: 0, alignment: "left" },
        { start: 4, alignment: "right" },
      ],
    });
  });
});

describe("text source batch validation", () => {
  it("shares its prepared range mapper with persisted layout without rebuilding source", () => {
    const state: TextSourceState = { source: "**bold** plain", ranges: [], paragraphs: [] };
    const formatting = toggleTextMarkdownMark(state.source, { start: 0, end: 8 }, "bold");
    let map: TextSourceRangeMapper | undefined;
    const steps = applyTextEditsSteps(state, formatting.changes, (mapper) => {
      map = mapper;
    });
    let result = steps.next();
    while (!result.done) result = steps.next();
    if (!map) throw new Error("Expected the prepared range mapper.");
    expect(result.value.source).toBe("bold plain");
    expect(map({ start: 2, end: 6 })).toEqual({ start: 0, end: 4 });
    expect(map({ start: 9, end: 14 })).toEqual({ start: 5, end: 10 });
    expect(() => map!({ start: 0, end: 15 })).toThrow(RangeError);
    let identity: TextSourceRangeMapper | undefined;
    const noOp = applyTextEditsSteps(state, [], (mapper) => {
      identity = mapper;
    });
    expect(noOp.next()).toEqual({ done: true, value: state });
    if (!identity) throw new Error("Expected an identity range mapper.");
    expect(identity({ start: 2, end: 6 })).toEqual({ start: 2, end: 6 });
  });

  it("rejects overlapping, unsorted, and oversized transactions without changing the input", () => {
    const state: TextSourceState = { source: "abcdef", ranges: [], paragraphs: [] };
    expect(() =>
      apply(state, [
        { start: 0, end: 3, insert: "" },
        { start: 2, end: 4, insert: "x" },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      apply(state, [
        { start: 0, end: 0, insert: "a" },
        { start: 5, end: 5, insert: "b" },
        { start: 3, end: 3, insert: "c" },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      apply(state, [{ start: 0, end: 0, insert: "x".repeat(MAX_TEXT_SOURCE_LENGTH) }]),
    ).toThrow(RangeError);
    expect(apply(state, [])).toBe(state);
    expect(apply(state, [{ start: 0, end: 0, insert: "" }])).toBe(state);
    expect(state.source).toBe("abcdef");
  });
});
