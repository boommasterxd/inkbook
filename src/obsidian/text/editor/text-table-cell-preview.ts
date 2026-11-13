import type {
  TextMarkdownBlock,
  TextMarkdownTableCell,
  TextSourceRange,
} from "../../../domain/text/text-types";
import type { TextStyleV2 } from "../../../domain/schema/public";
import { indexTextPreviewSteps, type IndexedTextPreview } from "./text-preview-index";

export interface TextTableCellPresentation {
  readonly style: TextStyleV2;
  readonly width: number;
  readonly alignment: "left" | "center" | "right";
  readonly block?: TextMarkdownBlock;
  readonly cell?: TextMarkdownTableCell;
  readonly parentSource?: string;
}

/** Rebase the authoritative parse; an unprepared cell remains native source text. */
export function* textTableCellPreviewSteps(
  source: string,
  presentation: TextTableCellPresentation,
): Generator<void, IndexedTextPreview> {
  const { block, cell, parentSource, alignment } = presentation;
  const runs: TextMarkdownBlock["runs"][number][] = [];
  const spans: TextMarkdownBlock["spans"][number][] = [];
  if (block && cell && parentSource?.slice(cell.contentStart, cell.contentEnd) === source) {
    const range = { start: cell.contentStart, end: cell.contentEnd };
    for (const run of containedRanges(block.runs, range)) {
      runs.push(localRange(run, range.start));
      yield;
    }
    for (const span of containedRanges(block.spans, range)) {
      spans.push(localRange(span, range.start));
      yield;
    }
  }
  const paragraph: TextMarkdownBlock = {
    kind: "paragraph",
    start: 0,
    end: source.length,
    contentStart: 0,
    contentEnd: source.length,
    alignment,
    runs,
    spans,
  };
  return yield* indexTextPreviewSteps({ source, blocks: [paragraph], spans });
}

function* containedRanges<Value extends TextSourceRange>(
  values: readonly Value[],
  range: TextSourceRange,
): Generator<Value> {
  let lower = 0;
  let upper = values.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (values[middle]!.start < range.start) lower = middle + 1;
    else upper = middle;
  }
  for (let index = lower; index < values.length; index += 1) {
    const value = values[index]!;
    if (value.start >= range.end) break;
    if (value.end <= range.end) yield value;
  }
}

function localRange<Value extends TextSourceRange & { contentStart: number; contentEnd: number }>(
  value: Value,
  offset: number,
): Value {
  return {
    ...value,
    start: value.start - offset,
    end: value.end - offset,
    contentStart: value.contentStart - offset,
    contentEnd: value.contentEnd - offset,
  };
}
