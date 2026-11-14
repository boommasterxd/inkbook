import { describe, expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { createSelectedTextToolbarIcon } from "../../../../../src/obsidian/embeds/active-editor/text-toolbar-icon";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import type { TextMarkdownDocument } from "../../../../../src/domain/text/text-types";
import { textSelectionSummary } from "../../../../../src/obsidian/embeds/active-editor/text-session-presentation";
import { observeSchemaArray } from "../../../../fixtures/domain/schema-array-work";
import { textElement } from "../../../../unit/domain/schema/fixtures";

function observeDocument(document: TextMarkdownDocument) {
  const work = { runs: 0, unrelatedRuns: 0, selectedBlock: 0 };
  const blocks = observeSchemaArray(
    document.blocks.map((block, index) => ({
      ...block,
      runs: observeSchemaArray(block.runs, () => {
        work.runs += 1;
        if (index !== work.selectedBlock) work.unrelatedRuns += 1;
      }).observed,
    })),
  );
  return { document: { ...document, blocks: blocks.observed }, blocks: blocks.work, work };
}

describe("text caret Style lookup work", () => {
  it.each([32, 3000])(
    "reads only logarithmic block candidates in a %i-paragraph field",
    (count) => {
      const paragraph = "alpha **bold** and `code` tail\n\n";
      const base = paragraph.repeat(count);
      const source = count === 3000 ? base + "x".repeat(100_000 - base.length) : base;
      const element = { ...textElement(), source };
      const parsed = parseTextMarkdown(source, { style: element.style });
      const observed = observeDocument(parsed);
      const paragraphIndex = Math.floor(count / 2);
      observed.work.selectedBlock = paragraphIndex * 2;
      const start = paragraphIndex * paragraph.length + paragraph.indexOf("code") + 1;
      const summary = textSelectionSummary(element, observed.document, start, start);
      expect(summary.style.fontFamily).toBe("jetbrains-mono");
      expect(observed.work.unrelatedRuns).toBe(0);
      expect(observed.blocks.indexedReads).toBeLessThanOrEqual(
        Math.ceil(Math.log2(parsed.blocks.length)) + 2,
      );
      expect(observed.work.runs).toBeLessThanOrEqual(
        Math.ceil(Math.log2(parsed.blocks[paragraphIndex * 2]!.runs.length)) + 2,
      );
      if (count === 3000) expect(source.length).toBe(100_000);
    },
  );

  it("reuses the sorted run array for caret moves, local selection and source-end lookup", () => {
    const part = "plain **bold** `code` ";
    const source = part.repeat(3000) + "tail";
    const element = { ...textElement(), source };
    const parsed = parseTextMarkdown(source, { style: element.style });
    const observed = observeDocument(parsed);
    const middle = part.length * 1500;
    const checks = [
      {
        start: middle + part.indexOf("code"),
        end: middle + part.indexOf("code"),
        font: "jetbrains-mono",
      },
      {
        start: middle + part.indexOf("bold"),
        end: middle + part.indexOf("bold"),
        font: element.style.fontFamily,
      },
      {
        start: middle + part.indexOf("bold"),
        end: middle + part.indexOf("code") + 4,
        font: "mixed",
      },
      { start: source.length, end: source.length, font: element.style.fontFamily },
    ];
    for (const check of checks) {
      const beforeRuns = observed.work.runs;
      const beforeBlocks = observed.blocks.indexedReads;
      const summary = textSelectionSummary(element, observed.document, check.start, check.end);
      expect(summary.style.fontFamily).toBe(check.font);
      expect(observed.work.runs - beforeRuns).toBeLessThanOrEqual(
        Math.ceil(Math.log2(parsed.blocks[0]!.runs.length)) + 5,
      );
      expect(observed.blocks.indexedReads - beforeBlocks).toBeLessThanOrEqual(2);
    }
    expect(observed.work.unrelatedRuns).toBe(0);
  });
});

it("reuses large text paint summaries and stops at one non-text record in a 10000-stroke selection", () => {
  const text = textElement();
  text.source = Array.from({ length: 3000 }, () => "Hello").join("\n");
  text.height = 60000;
  text.pivot = { x: text.x + text.width / 2, y: text.y + text.height / 2 };
  text.layout.lines = Array.from({ length: 3000 }, (_, index) => ({
    x: 0,
    y: index * 20,
    width: 40,
    height: 20,
    baseline: 15,
    runs: [{ text: "Hello", start: index * 6, end: index * 6 + 5, x: 0, width: 40 }],
  }));
  const strokes = Array.from({ length: 10000 }, (_, index) => indexedStroke(index));
  const store = new ElementStore([text, ...strokes]);
  const original = store.get(text.id)!;
  const lines = observeSchemaArray(text.layout.lines);
  const observed = {
    ...original,
    element: { ...text, layout: { ...text.layout, lines: lines.observed } },
  };
  const get = store.get.bind(store);
  const reads = vi
    .spyOn(store, "get")
    .mockImplementation((id) => (id === text.id ? observed : get(id)));
  let selection = new Set([text.id]);
  const icon = createSelectedTextToolbarIcon(store, () => selection);
  expect(icon("select")?.text?.bold).toBe(false);
  const initial = lines.work.indexedReads;
  expect(initial).toBe(3000);
  for (let index = 0; index < 100; index += 1) icon("select");
  store.replace(strokes[0]!.id, { ...strokes[0]!, rotation: 15 });
  icon("select");
  expect(lines.work.indexedReads).toBe(initial);
  selection = new Set(strokes.map(({ id }) => id));
  reads.mockClear();
  for (let index = 0; index < 100; index += 1) icon("select");
  expect(reads).toHaveBeenCalledTimes(1);
  reads.mockRestore();
});
