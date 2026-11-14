import { MAX_TEXT_SOURCE_LENGTH, type TextStyleV2 } from "../schema/public";
import { textBlockSourcesSteps, type TextBlockSource } from "./markdown-blocks";
import { parseTextInlineSteps, type TextInlineResult } from "./markdown-inline";
import { textBlockBaseStyle } from "./text-layout-style";
import { textStyleSegmentsSteps, type TextStyleSegment } from "./text-style-segments";
import type {
  TextInlineToken,
  TextMarkdownBlock,
  TextMarkdownDocument,
  TextMarkdownRun,
  TextMarkSpan,
  TextParseOptions,
} from "./text-types";

/** The consumer drives admission through WorkScheduler; this generator schedules no work. */
export function* parseTextMarkdownSteps(
  source: string,
  options: TextParseOptions,
): Generator<void, TextMarkdownDocument> {
  if (source.length > MAX_TEXT_SOURCE_LENGTH)
    throw new RangeError("Text source capacity exceeded.");
  const blocks = yield* textBlockSourcesSteps(source);
  const segments = yield* textStyleSegmentsSteps(options.ranges ?? [], source.length);
  const result: TextMarkdownBlock[] = [];
  const spans: TextMarkSpan[] = [];
  const paragraphs = [...(options.paragraphs ?? [])].sort((a, b) => a.start - b.start);
  let paragraphIndex = -1;
  let segmentIndex = 0;
  for (const block of blocks) {
    while (
      paragraphIndex + 1 < paragraphs.length &&
      paragraphs[paragraphIndex + 1]!.start <= block.start
    )
      paragraphIndex += 1;
    const alignment = paragraphs[paragraphIndex]?.alignment ?? "left";
    let alignmentEnd = paragraphIndex + 1;
    while (alignmentEnd < paragraphs.length && paragraphs[alignmentEnd]!.start <= block.end) {
      alignmentEnd += 1;
      yield;
    }
    const sourceAlignments = paragraphs.slice(paragraphIndex + 1, alignmentEnd);
    const parsed = yield* blockInlineSteps(source, block);
    const blockSpans = [...parsed.spans].sort((a, b) => a.start - b.start || b.end - a.end);
    for (const span of blockSpans) spans.push(span);
    const runs: TextMarkdownRun[] = [];
    const base = textBlockBaseStyle(options.style, block.kind === "heading");
    const headerEnd = block.table?.rows[0]?.end ?? -1;
    for (const token of parsed.tokens) {
      while (segmentIndex + 1 < segments.length && segments[segmentIndex]!.end <= token.start)
        segmentIndex += 1;
      const inherited = token.start < headerEnd ? { ...base, bold: true } : base;
      const styled = yield* styledRuns(token, segments, segmentIndex, inherited);
      for (const run of styled) runs.push(run);
      yield;
    }
    result.push({
      ...block,
      alignment,
      sourceAlignments,
      runs,
      spans: blockSpans,
    });
    yield;
  }
  return { source, blocks: result, spans };
}

function* blockInlineSteps(
  source: string,
  block: TextBlockSource,
): Generator<void, TextInlineResult> {
  if (block.kind === "math")
    return {
      spans: [],
      tokens: [
        {
          start: block.start,
          end: block.end,
          contentStart: block.contentStart,
          contentEnd: block.contentEnd,
          kind: "math",
          display: true,
          text: source.slice(block.contentStart, block.contentEnd).trim(),
          marks: [],
        },
      ],
    };
  if (!block.table)
    return yield* parseTextInlineSteps(source, block.contentStart, block.contentEnd);
  const tokens: TextInlineToken[] = [];
  const spans: TextMarkSpan[] = [];
  for (const row of block.table.rows) {
    for (const cell of row.cells) {
      const parsed = yield* parseTextInlineSteps(source, cell.contentStart, cell.contentEnd);
      for (const token of parsed.tokens) {
        tokens.push(token);
        yield;
      }
      for (const span of parsed.spans) {
        spans.push(span);
        yield;
      }
    }
  }
  return { tokens, spans };
}

function* styledRuns(
  token: TextInlineToken,
  segments: readonly TextStyleSegment[],
  segmentIndex: number,
  base: TextStyleV2,
): Generator<void, TextMarkdownRun[]> {
  const semantic: TextStyleV2 = {
    ...base,
    bold: base.bold || token.marks.includes("bold"),
    italic: base.italic || token.marks.includes("italic"),
    strikethrough: base.strikethrough || token.marks.includes("strikethrough"),
  };
  const result: TextMarkdownRun[] = [];
  let contentStart = token.contentStart;
  while (segmentIndex + 1 < segments.length && segments[segmentIndex]!.end <= contentStart)
    segmentIndex += 1;
  do {
    const segment = segments[segmentIndex];
    const contentEnd =
      token.kind === "math"
        ? token.contentEnd
        : Math.min(token.contentEnd, segment?.end ?? token.contentEnd);
    const text =
      token.kind === "math"
        ? token.text
        : token.text.slice(contentStart - token.contentStart, contentEnd - token.contentStart);
    result.push({
      start: contentStart === token.contentStart ? token.start : contentStart,
      end: contentEnd === token.contentEnd ? token.end : contentEnd,
      contentStart,
      contentEnd,
      kind: token.kind,
      text,
      ...(token.kind === "math" ? { latex: token.text, display: token.display ?? false } : {}),
      style: { ...semantic, ...segment?.style },
      code: token.marks.includes("code"),
    });
    contentStart = contentEnd;
    segmentIndex += 1;
    yield;
  } while (contentStart < token.contentEnd);
  return result;
}
