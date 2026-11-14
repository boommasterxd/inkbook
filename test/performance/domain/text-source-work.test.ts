import { describe, expect, it, vi } from "vitest";

import * as inlineParser from "../../../src/domain/text/markdown-inline";
import * as blockParser from "../../../src/domain/text/markdown-blocks";
import { toggleTextMarkdownMark, parseTextMarkdown } from "../../fixtures/domain/text-source";
import {
  applyTextEditsSteps,
  applyTextParagraphAlignmentSteps,
} from "../../../src/domain/text/text-source-edits";
import { textBlockAlignmentAt } from "../../../src/domain/text/text-paragraph-alignment";
import type { TextSourceState } from "../../../src/domain/text/text-types";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { textElement } from "../../unit/domain/schema/fixtures";

describe("source line alignment work", () => {
  it("updates one line with one existing-anchor read pass and no Markdown reparse", () => {
    const source = "line\n".repeat(5000);
    const paragraphs = observeSchemaArray(
      Array.from({ length: 4096 }, (_, index) => ({
        start: index * 5,
        alignment: "center" as const,
      })),
    );
    const parsing = vi.spyOn(blockParser, "textBlockSourcesSteps");
    try {
      const steps = applyTextParagraphAlignmentSteps(
        { source, ranges: [], paragraphs: paragraphs.observed },
        { start: 10_001, end: 10_001 },
        "right",
      );
      let step = steps.next();
      let previous = 0;
      while (!step.done) {
        expect(paragraphs.work.indexedReads - previous).toBeLessThanOrEqual(1);
        previous = paragraphs.work.indexedReads;
        step = steps.next();
      }
      expect(paragraphs.work.indexedReads).toBe(4096);
      expect(parsing).not.toHaveBeenCalled();
      expect(step.value.paragraphs.find((record) => record.start === 10_000)).toEqual({
        start: 10_000,
        alignment: "right",
      });
      expect(step.value.paragraphs.find((record) => record.start === 10_005)).toEqual({
        start: 10_005,
        alignment: "center",
      });
    } finally {
      parsing.mockRestore();
    }
  });

  it("looks up one source line through logarithmic sparse-alignment reads", () => {
    const records = observeSchemaArray(
      Array.from({ length: 4096 }, (_, index) => ({
        start: index * 5,
        alignment: "right" as const,
      })),
    );
    expect(
      textBlockAlignmentAt({ alignment: "left", sourceAlignments: records.observed }, 15_001),
    ).toBe("right");
    expect(records.work.indexedReads).toBeLessThanOrEqual(Math.ceil(Math.log2(4096)) + 2);
  });
});

describe("cached text source formatting work", () => {
  it("probes only the empty caret paragraph in a cached 3,000-paragraph field", () => {
    const paragraph = "paragraph\n\n";
    const prefix = paragraph.repeat(1500);
    const source = prefix + "***~~~~***\n\n" + paragraph.repeat(1499);
    const document = parseTextMarkdown(source, { style: textElement().style });
    const blocks = observeSchemaArray(document.blocks);
    const parsing = vi.spyOn(inlineParser, "parseTextInlineSteps");
    try {
      const caret = prefix.length + 5;
      const result = toggleTextMarkdownMark(source, { start: caret, end: caret }, "bold", {
        ...document,
        blocks: blocks.observed,
      });
      expect(result.source).toBe(prefix + "*~~~~*\n\n" + paragraph.repeat(1499));
      expect(result.markActive).toBe(false);
      expect(parsing).toHaveBeenCalledTimes(1);
      expect(parsing.mock.calls[0]![0]).toBe("***~~x~~***");
      expect(blocks.work.indexedReads).toBeLessThanOrEqual(
        Math.ceil(Math.log2(document.blocks.length)) + 4,
      );
    } finally {
      parsing.mockRestore();
    }
  });

  it.each([32, 3000])("visits only the selected paragraph in a %i-paragraph field", (count) => {
    const paragraph = "**alpha *both* omega**\n\n";
    const source = paragraph.repeat(count);
    const document = parseTextMarkdown(source, { style: textElement().style });
    const selected = Math.floor(count / 2);
    const start = paragraph.length * selected;
    const end = start + paragraph.length - 2;
    let runReads = 0;
    let spanReads = 0;
    let unrelatedReads = 0;
    const observedBlocks = document.blocks.map((block, index) => {
      const runs = observeSchemaArray(block.runs, () => {
        runReads += 1;
        if (index !== selected * 2) unrelatedReads += 1;
      });
      const spans = observeSchemaArray(block.spans, () => {
        spanReads += 1;
        if (index !== selected * 2) unrelatedReads += 1;
      });
      return { ...block, runs: runs.observed, spans: spans.observed };
    });
    const blocks = observeSchemaArray(observedBlocks);
    const parsing = vi.spyOn(inlineParser, "parseTextInlineSteps");
    try {
      const result = toggleTextMarkdownMark(source, { start, end }, "bold", {
        ...document,
        blocks: blocks.observed,
      });
      expect(result.source.slice(start, start + "alpha *both* omega".length)).toBe(
        "alpha *both* omega",
      );
      expect(result.source.length).toBe(source.length - 4);
      expect(parsing).not.toHaveBeenCalled();
      expect(unrelatedReads).toBe(0);
      expect(runReads).toBe(document.blocks[selected * 2]!.runs.length);
      expect(spanReads).toBe(document.blocks[selected * 2]!.spans.length * 2);
      expect(blocks.work.indexedReads).toBeLessThanOrEqual(
        Math.ceil(Math.log2(document.blocks.length)) + 4,
      );
    } finally {
      parsing.mockRestore();
    }
  });
});

describe("batch text source rebasing work", () => {
  it("reads each of 4,096 style ranges and 3,000 paragraph anchors once for 6,000 delimiter edits", () => {
    const paragraph = "**alpha**\n\n";
    const source = paragraph.repeat(3000);
    const formatting = toggleTextMarkdownMark(source, { start: 0, end: source.length }, "bold");
    const ranges = observeSchemaArray(
      Array.from({ length: 4096 }, (_, index) => ({
        start: (index % 3000) * paragraph.length + 2,
        end: (index % 3000) * paragraph.length + 7,
        style: { underline: true },
      })),
    );
    const paragraphs = observeSchemaArray(
      Array.from({ length: 3000 }, (_, index) => ({
        start: index * paragraph.length,
        alignment: "center" as const,
      })),
    );
    const changes = observeSchemaArray(formatting.changes);
    const state: TextSourceState = {
      source,
      ranges: ranges.observed,
      paragraphs: paragraphs.observed,
    };
    const steps = applyTextEditsSteps(state, changes.observed);
    let step = steps.next();
    let before = 0;
    while (!step.done) {
      const reads =
        ranges.work.indexedReads + paragraphs.work.indexedReads + changes.work.indexedReads;
      expect(reads - before).toBeLessThanOrEqual(3);
      before = reads;
      step = steps.next();
    }
    expect(step.value.source).toBe(formatting.source);
    expect(step.value.ranges[0]).toMatchObject({ start: 0, end: 5 });
    expect(step.value.paragraphs[2999]!.start).toBe(2999 * "alpha\n\n".length);
    expect(ranges.work.indexedReads).toBe(4096);
    expect(paragraphs.work.indexedReads).toBe(3000);
    expect(changes.work.indexedReads).toBeLessThanOrEqual(formatting.changes.length + 2);
  });

  it("can cancel a planned source transaction before reading its style ranges", () => {
    const ranges = observeSchemaArray([{ start: 0, end: 5, style: { underline: true } }]);
    const steps = applyTextEditsSteps(
      { source: "alpha", ranges: ranges.observed, paragraphs: [] },
      [
        { start: 0, end: 0, insert: "**" },
        { start: 5, end: 5, insert: "**" },
      ],
    );
    expect(steps.next().done).toBe(false);
    steps.return({ source: "alpha", ranges: [], paragraphs: [] });
    expect(ranges.work.indexedReads).toBe(0);
  });
});
