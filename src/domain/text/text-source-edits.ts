import {
  MAX_TEXT_STYLE_RANGES,
  type TextParagraphStyleV2,
  type TextStyleRangeV2,
  type TextRangeStyleV2,
} from "../schema/public";
import { assertTextSourceRange } from "./text-source-batch";
import { textStyleSegmentsSteps } from "./text-style-segments";
import type { TextSourceChange, TextSourceRange, TextSourceState } from "./text-types";

export {
  applyTextEditsSteps,
  assertTextSourceRange,
  type TextSourceRangeMapper,
} from "./text-source-batch";

/** UTF-16 offsets match the source editor and never refer to rendered character indexes. */
export function rebaseTextPosition(
  position: number,
  change: TextSourceChange,
  association: -1 | 1 = 1,
): number {
  if (position < change.start || (position === change.start && association < 0)) return position;
  if (position > change.end || (position === change.end && association > 0))
    return position + change.insert.length - (change.end - change.start);
  return change.start + (association < 0 ? 0 : change.insert.length);
}

export function applyTextStyleRange(
  state: TextSourceState,
  selection: TextSourceRange,
  style: TextRangeStyleV2,
): TextSourceState {
  return completeTextSteps(applyTextStyleRangeSteps(state, selection, style));
}

export function* applyTextStyleRangeSteps(
  state: TextSourceState,
  selection: TextSourceRange,
  style: TextRangeStyleV2,
): Generator<void, TextSourceState> {
  assertTextSourceRange(state.source, selection);
  if (selection.start === selection.end || !Object.keys(style).length) return state;
  const ranges = yield* compactTextStyleRangesSteps(
    [...state.ranges, { ...selection, style }],
    state.source.length,
  );
  return { ...state, ranges };
}

export function* compactTextStyleRangesSteps(
  input: readonly TextStyleRangeV2[],
  sourceLength: number,
): Generator<void, TextStyleRangeV2[]> {
  const segments = yield* textStyleSegmentsSteps(input, sourceLength);
  const ranges: TextStyleRangeV2[] = [];
  for (const segment of segments) {
    if (!Object.keys(segment.style).length) continue;
    const previous = ranges[ranges.length - 1];
    if (previous?.end === segment.start && equalTextStyle(previous.style, segment.style))
      previous.end = segment.end;
    else ranges.push({ ...segment });
    yield;
  }
  if (ranges.length > MAX_TEXT_STYLE_RANGES) throw new RangeError("Text style capacity exceeded.");
  return ranges;
}

export function applyTextParagraphAlignment(
  state: TextSourceState,
  selection: TextSourceRange,
  alignment: TextParagraphStyleV2["alignment"],
): TextSourceState {
  return completeTextSteps(applyTextParagraphAlignmentSteps(state, selection, alignment));
}

export function* applyTextParagraphAlignmentSteps(
  state: TextSourceState,
  selection: TextSourceRange,
  alignment: TextParagraphStyleV2["alignment"],
): Generator<void, TextSourceState> {
  assertTextSourceRange(state.source, selection);
  const first = selection.start === 0 ? 0 : state.source.lastIndexOf("\n", selection.start - 1) + 1;
  const last = selection.end > selection.start ? selection.end - 1 : selection.end;
  const followingBreak = state.source.indexOf("\n", last);
  const following = followingBreak < 0 ? undefined : followingBreak + 1;
  const paragraphs = new Map<number, TextParagraphStyleV2>();
  let followingAlignment: TextParagraphStyleV2["alignment"] = "left";
  let latest = -1;
  for (const paragraph of state.paragraphs) {
    paragraphs.set(paragraph.start, paragraph);
    if (following !== undefined && paragraph.start <= following && paragraph.start >= latest) {
      followingAlignment = paragraph.alignment;
      latest = paragraph.start;
    }
    yield;
  }
  let start = first;
  while (start <= last) {
    paragraphs.set(start, { start, alignment });
    const next = state.source.indexOf("\n", start);
    if (next < 0) break;
    start = next + 1;
    yield;
  }
  if (following !== undefined && !paragraphs.has(following))
    paragraphs.set(following, { start: following, alignment: followingAlignment });
  if (paragraphs.size > MAX_TEXT_STYLE_RANGES)
    throw new RangeError("Text paragraph capacity exceeded.");
  return { ...state, paragraphs: [...paragraphs.values()].sort((a, b) => a.start - b.start) };
}

function equalTextStyle(left: TextRangeStyleV2, right: TextRangeStyleV2): boolean {
  const keys = Object.keys(left) as (keyof TextRangeStyleV2)[];
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function completeTextSteps<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
