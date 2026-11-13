import { describe, expect, it } from "vitest";
import { formatTextMarkdownStyle } from "../../../../src/domain/text/text-mark-formatting";
import { applyTextEditsSteps } from "../../../../src/domain/text/text-source-edits";
import type { TextSourceState } from "../../../../src/domain/text/text-types";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { textElement } from "../schema/fixtures";

const base = textElement().style;

describe("source mark and rich Boolean conflicts", () => {
  it("disables only the selected word inherited from the field base style", () => {
    const state = { source: "left word right", ranges: [], paragraphs: [] };
    const style = { ...base, bold: true };
    const result = formatTextMarkdownStyle(
      state,
      { start: 5, end: 9 },
      { mark: "bold", desired: false, base: style },
    );
    expect(result.stateBeforeChanges).toEqual({
      ...state,
      ranges: [{ start: 5, end: 9, style: { bold: false } }],
    });
    expect(result.changes).toEqual([]);
    const document = parseTextMarkdown(state.source, {
      style,
      ranges: result.stateBeforeChanges.ranges,
    });
    expect(document.blocks[0]!.runs.map((run) => [run.text, run.style.bold])).toEqual([
      ["left ", true],
      ["word", false],
      [" right", true],
    ]);
  });

  it("clears only a selected rich mark while preserving overlapping independent and outside styles", () => {
    const state: TextSourceState = {
      source: "left word right",
      ranges: [{ start: 0, end: 15, style: { bold: true, underline: true } }],
      paragraphs: [],
    };
    const result = formatTextMarkdownStyle(
      state,
      { start: 5, end: 9 },
      { mark: "bold", desired: false, base },
    );
    expect(result.stateBeforeChanges.ranges).toEqual([
      { start: 0, end: 5, style: { bold: true, underline: true } },
      { start: 5, end: 9, style: { underline: true } },
      { start: 9, end: 15, style: { bold: true, underline: true } },
    ]);
    expect(result.stateBeforeChanges.source).toBe(state.source);
    expect(result.changes).toEqual([]);
  });

  it("enables a source-marked word by removing its false rich override and rebases other ranges once", () => {
    const state: TextSourceState = {
      source: "**word**",
      ranges: [{ start: 2, end: 6, style: { bold: false, underline: true } }],
      paragraphs: [],
    };
    const result = formatTextMarkdownStyle(
      state,
      { start: 2, end: 6 },
      { mark: "bold", desired: true, base },
    );
    expect(result.source).toBe(state.source);
    expect(result.stateBeforeChanges.ranges).toEqual([
      { start: 2, end: 6, style: { underline: true } },
    ]);
    const resolved = finishGeometrySteps(
      applyTextEditsSteps(result.stateBeforeChanges, result.changes),
    );
    expect(
      parseTextMarkdown(resolved.source, { style: base, ranges: resolved.ranges }).blocks[0]!
        .runs[0]!.style,
    ).toMatchObject({ bold: true, underline: true });
  });
});

describe("Markdown-only and caret style ownership", () => {
  it("keeps ordinary Markdown formatting free of independent Boolean ranges", () => {
    const state: TextSourceState = {
      source: "word",
      ranges: [{ start: 0, end: 4, style: { underline: true } }],
      paragraphs: [],
    };
    const result = formatTextMarkdownStyle(
      state,
      { start: 0, end: 4 },
      { mark: "bold", desired: true, base },
    );
    expect(result.source).toBe("**word**");
    expect(result.stateBeforeChanges).toBe(state);
    const resolved = finishGeometrySteps(
      applyTextEditsSteps(result.stateBeforeChanges, result.changes),
    );
    expect(resolved.ranges).toEqual([{ start: 2, end: 8, style: { underline: true } }]);
    expect(result.typingOverride).toBeUndefined();
  });

  it("returns a typing override only for inherited or rich conflicts at the caret", () => {
    const state: TextSourceState = {
      source: "word",
      ranges: [{ start: 0, end: 4, style: { bold: true } }],
      paragraphs: [],
    };
    const caret = { start: 2, end: 2 };
    expect(
      formatTextMarkdownStyle(state, caret, { mark: "bold", desired: false, base }).typingOverride,
    ).toBe(false);
    expect(
      formatTextMarkdownStyle({ ...state, ranges: [] }, caret, {
        mark: "bold",
        desired: false,
        base: { ...base, bold: true },
      }).typingOverride,
    ).toBe(false);
    expect(
      formatTextMarkdownStyle(
        {
          source: "**word**",
          ranges: [{ start: 2, end: 6, style: { bold: false } }],
          paragraphs: [],
        },
        { start: 4, end: 4 },
        { mark: "bold", desired: true, base },
      ).typingOverride,
    ).toBe(true);
    expect(
      formatTextMarkdownStyle({ ...state, ranges: [] }, caret, {
        mark: "bold",
        desired: true,
        base,
      }).typingOverride,
    ).toBeUndefined();
  });

  it("toggles the effective rich or base style instead of adding a redundant source marker", () => {
    const state: TextSourceState = { source: "word", ranges: [], paragraphs: [] };
    const result = formatTextMarkdownStyle(
      state,
      { start: 0, end: 4 },
      { mark: "bold", desired: undefined, base: { ...base, bold: true } },
    );
    expect(result).toMatchObject({
      source: "word",
      markActive: false,
      stateBeforeChanges: { ranges: [{ start: 0, end: 4, style: { bold: false } }] },
    });
  });
});
