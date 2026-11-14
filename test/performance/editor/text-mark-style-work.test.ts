import { afterEach, expect, it, vi } from "vitest";
import { applySelectionStyleChange } from "../../../src/editor/tools/style-change";
import type { TextElementV2 } from "../../../src/domain/schema/public";
import { layoutTextElement } from "../../fixtures/editor/text-style";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { textElement } from "../../unit/domain/schema/fixtures";
import * as sourceEdits from "../../../src/domain/text/text-source-edits";
import * as markdownParser from "../../../src/domain/text/markdown-parser";
import * as markdownBlocks from "../../../src/domain/text/markdown-blocks";
import * as styleSegments from "../../../src/domain/text/text-style-segments";

afterEach(() => vi.restoreAllMocks());

it("checks rich conflicts then rebases 3000 marked paragraphs, 4096 independent ranges and retained layout once", async () => {
  const paragraph = "**abcdefghij** plain textxxxxx\n\n";
  const source = paragraph.repeat(3000);
  const original = await layoutTextElement({
    ...textElement(),
    source,
    width: 1200,
    ranges: Array.from({ length: 4096 }, () => ({
      start: 0,
      end: source.length,
      style: { underline: true },
    })),
    paragraphs: Array.from({ length: 3000 }, (_, index) => ({
      start: index * paragraph.length,
      alignment: "center" as const,
    })),
  });
  let runReads = 0;
  const lines = observeSchemaArray(
    original.layout.lines.map((line) => ({
      ...line,
      runs: observeSchemaArray(line.runs, () => {
        runReads += 1;
      }).observed,
    })),
  );
  const ranges = observeSchemaArray(original.ranges);
  const paragraphs = observeSchemaArray(original.paragraphs);
  const rebase = vi.spyOn(sourceEdits, "applyTextEditsSteps");
  const semanticParse = vi.spyOn(markdownParser, "parseTextMarkdownSteps");
  const blockSources = vi.spyOn(markdownBlocks, "textBlockSourcesSteps");
  const richStyles = vi.spyOn(styleSegments, "textStyleSegmentsSteps");
  const result = applySelectionStyleChange(
    [
      {
        ...original,
        ranges: ranges.observed,
        paragraphs: paragraphs.observed,
        layout: { ...original.layout, lines: lines.observed },
      },
    ],
    { property: "text-bold", value: false },
  );
  const updated = result.elements[0] as TextElementV2;
  expect(updated.source).toBe("abcdefghij plain textxxxxx\n\n".repeat(3000));
  expect(updated.ranges).toHaveLength(4096);
  expect(updated.ranges[4095]).toMatchObject({
    start: 0,
    end: updated.source.length,
    style: { underline: true },
  });
  expect(updated.paragraphs[2999]?.start).toBe(2999 * "abcdefghij plain textxxxxx\n\n".length);
  // One conflict-inspection pass and one source-offset rebase, without glyph-style reconstruction.
  expect(ranges.work.indexedReads).toBe(4096 * 2);
  expect(rebase).toHaveBeenCalledTimes(1);
  expect(rebase.mock.calls[0]![0].ranges).toBe(ranges.observed);
  expect(rebase.mock.calls[0]![1]).toHaveLength(6000);
  expect(semanticParse).not.toHaveBeenCalled();
  expect(richStyles).not.toHaveBeenCalled();
  expect(blockSources).toHaveBeenCalledTimes(1);
  expect(paragraphs.work.indexedReads).toBe(3000);
  expect(lines.work.indexedReads).toBe(original.layout.lines.length);
  expect(runReads).toBe(original.layout.lines.reduce((total, line) => total + line.runs.length, 0));
});
