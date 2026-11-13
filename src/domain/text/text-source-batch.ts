import {
  MAX_TEXT_SOURCE_LENGTH,
  type TextParagraphStyleV2,
  type TextStyleRangeV2,
} from "../schema/public";
import type { TextSourceChange, TextSourceRange, TextSourceState } from "./text-types";

interface PlannedChange {
  readonly change: TextSourceChange;
  readonly deltaBefore: number;
  readonly deltaAfter: number;
  paragraphStart: number;
}

export type TextSourceRangeMapper = (range: TextSourceRange) => TextSourceRange;

export function assertTextSourceRange(source: string, range: TextSourceRange): void {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > source.length
  ) {
    throw new RangeError("Invalid text source range.");
  }
}

/** Changes use original UTF-16 offsets and must be disjoint and sorted in either direction. */
export function* applyTextEditsSteps(
  state: TextSourceState,
  changes: readonly TextSourceChange[],
  onRangeMap?: (mapRange: TextSourceRangeMapper) => void,
): Generator<void, TextSourceState> {
  const plan = yield* planChangesSteps(state.source, changes);
  onRangeMap?.((range) => {
    assertTextSourceRange(state.source, range);
    return {
      start: mapStylePosition(plan, range.start, false),
      end: mapStylePosition(plan, range.end, true),
    };
  });
  if (!plan.length) return state;
  const pieces: string[] = [];
  let previousEnd = 0;
  for (const { change } of plan) {
    pieces.push(state.source.slice(previousEnd, change.start), change.insert);
    previousEnd = change.end;
    yield;
  }
  pieces.push(state.source.slice(previousEnd));
  const source = pieces.join("");
  const ranges: TextStyleRangeV2[] = [];
  for (const range of state.ranges) {
    const start = mapStylePosition(plan, range.start, false);
    const end = mapStylePosition(plan, range.end, true);
    if (start < end) ranges.push({ ...range, start, end });
    yield;
  }
  const paragraphs = new Map<number, TextParagraphStyleV2>();
  if (state.paragraphs.length) yield* prepareParagraphStartsSteps(state.source, plan);
  for (const paragraph of state.paragraphs) {
    const start = mapParagraphPosition(plan, paragraph.start, plan.length);
    paragraphs.set(start, { ...paragraph, start });
    yield;
  }
  return { source, ranges, paragraphs: [...paragraphs.values()].sort((a, b) => a.start - b.start) };
}

function* planChangesSteps(
  source: string,
  changes: readonly TextSourceChange[],
): Generator<void, PlannedChange[]> {
  const ascending = changes.length < 2 || changes[0]!.start < changes[1]!.start;
  const result: PlannedChange[] = [];
  let delta = 0;
  let previousStart = -1;
  let previousEnd = 0;
  for (let offset = 0; offset < changes.length; offset += 1) {
    const change = changes[ascending ? offset : changes.length - offset - 1]!;
    assertTextSourceRange(source, change);
    if (change.start < previousEnd || change.start <= previousStart)
      throw new RangeError("Text changes must be sorted and disjoint.");
    previousStart = change.start;
    previousEnd = change.end;
    if (change.start !== change.end || change.insert.length) {
      const next = delta + change.insert.length - (change.end - change.start);
      result.push({ change, deltaBefore: delta, deltaAfter: next, paragraphStart: 0 });
      delta = next;
    }
    yield;
  }
  if (source.length + delta > MAX_TEXT_SOURCE_LENGTH)
    throw new RangeError("Text source capacity exceeded.");
  return result;
}

function mapStylePosition(plan: readonly PlannedChange[], position: number, end: boolean): number {
  const index = precedingChange(plan, position, true, plan.length);
  if (index < 0) return position;
  const { change, deltaBefore, deltaAfter } = plan[index]!;
  if (position < change.end) return change.start + deltaBefore + (end ? change.insert.length : 0);
  return position + deltaAfter;
}

/** Binary lookup also supports strict starts for paragraph anchors that stick before inserts. */
function precedingChange(
  plan: readonly PlannedChange[],
  position: number,
  inclusive: boolean,
  length: number,
): number {
  let lower = 0;
  let upper = length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const start = plan[middle]!.change.start;
    if (start < position || (inclusive && start === position)) lower = middle + 1;
    else upper = middle;
  }
  return lower - 1;
}

function* prepareParagraphStartsSteps(source: string, plan: PlannedChange[]): Generator<void> {
  const lineStarts = [0];
  for (let position = 0; position < source.length; position += 1) {
    if (source[position] === "\n") lineStarts.push(position + 1);
    if (position % 256 === 0) yield;
  }
  for (let index = 0; index < plan.length; index += 1) {
    const entry = plan[index]!;
    const newline = entry.change.insert.lastIndexOf("\n");
    // Memoizing each collapsed anchor preserves descending-edit semantics without revisiting paragraphs.
    entry.paragraphStart =
      newline >= 0
        ? entry.change.start + newline + 1 + entry.deltaBefore
        : mapParagraphPosition(plan, previousLineStart(lineStarts, entry.change.start), index);
    yield;
  }
}

function previousLineStart(starts: readonly number[], position: number): number {
  let lower = 0;
  let upper = starts.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (starts[middle]! <= position) lower = middle + 1;
    else upper = middle;
  }
  return starts[lower - 1]!;
}

function mapParagraphPosition(
  plan: readonly PlannedChange[],
  position: number,
  length: number,
): number {
  const index = precedingChange(plan, position, false, length);
  if (index < 0) return position;
  const entry = plan[index]!;
  return position <= entry.change.end ? entry.paragraphStart : position + entry.deltaAfter;
}
