import { MAX_TEXT_SOURCE_LENGTH } from "../schema/public";
import { textBlockSourcesSteps, type TextBlockSource } from "./markdown-blocks";
import { parseTextInlineSteps } from "./markdown-inline";
import { emptyCaretMarkSpansSteps } from "./markdown-caret-formatting";
import { assertTextSourceRange, rebaseTextPosition } from "./text-source-edits";
import type {
  TextInlineToken,
  TextMarkdownMark,
  TextMarkSpan,
  TextMarkdownBlock,
  TextSourceChange,
  TextSourceRange,
} from "./text-types";

export interface TextMarkdownFormatResult {
  readonly source: string;
  readonly selection: TextSourceRange;
  /** Apply in descending source order when rebasing independent style ranges. */
  readonly changes: readonly TextSourceChange[];
  readonly markActive: boolean;
}

type TextMarkdownEditResult = Omit<TextMarkdownFormatResult, "markActive">;

export interface TextMarkdownFormattingSource {
  readonly source: string;
  readonly blocks: readonly (TextBlockSource | TextMarkdownBlock)[];
}

export function* toggleTextMarkdownMarkSteps(
  source: string,
  selection: TextSourceRange,
  mark: TextMarkdownMark,
  document?: TextMarkdownFormattingSource,
): Generator<void, TextMarkdownFormatResult> {
  return yield* formatTextMarkdownMarkSteps(source, selection, mark, {
    document,
    desired: undefined,
  });
}

export function* forceTextMarkdownMarkSteps(
  source: string,
  selection: TextSourceRange,
  mark: TextMarkdownMark,
  value: boolean,
  document?: TextMarkdownFormattingSource,
): Generator<void, TextMarkdownFormatResult> {
  return yield* formatTextMarkdownMarkSteps(source, selection, mark, { document, desired: value });
}

function* formatTextMarkdownMarkSteps(
  source: string,
  selection: TextSourceRange,
  mark: TextMarkdownMark,
  request: { document: TextMarkdownFormattingSource | undefined; desired: boolean | undefined },
): Generator<void, TextMarkdownFormatResult> {
  const { desired, document } = request;
  assertTextSourceRange(source, selection);
  const { tokens, spans, additions, caretBlock } = yield* formattingSourceSteps(
    source,
    selection,
    document,
  );
  const marker = markDelimiter(mark, source.slice(selection.start, selection.end));
  const caret = yield* formatCaretMarkSteps(source, selection, {
    spans,
    tokens,
    caretBlock,
    mark,
    desired,
    marker,
  });
  if (caret) return caret;
  const { action, active, markActive } = formattingAction(tokens, spans, selection, {
    mark,
    desired,
  });
  if (action === "none") return { source, selection, changes: [], markActive };
  if (action === "caret")
    return { ...(yield* toggleCaretMark(source, selection, active)), markActive };
  const remove = action === "remove";
  const changes: TextSourceChange[] = [];
  const retained: TextSourceRange[] = [];
  for (const span of spans) {
    yield;
    if (
      span.mark !== mark ||
      span.contentEnd <= selection.start ||
      span.contentStart >= selection.end
    )
      continue;
    changes.push(
      { start: span.start, end: span.contentStart, insert: "" },
      { start: span.contentEnd, end: span.end, insert: "" },
    );
    if (
      span.contentStart < selection.start &&
      hasVisibleContent(tokens, span.contentStart, selection.start)
    )
      retained.push({ start: span.contentStart, end: selection.start });
    if (
      span.contentEnd > selection.end &&
      hasVisibleContent(tokens, selection.end, span.contentEnd)
    )
      retained.push({ start: selection.end, end: span.contentEnd });
  }
  if (!remove)
    for (const addition of additions) {
      const range = desired === undefined ? addition : trimFormattingRange(source, addition);
      if (range.start < range.end || selection.start === selection.end) retained.push(range);
    }
  for (const range of retained) {
    changes.push(
      { start: range.start, end: range.start, insert: marker },
      { start: range.end, end: range.end, insert: marker },
    );
  }
  const result = yield* applyFormatChanges(
    source,
    selection,
    changes,
    !remove && selection.start === selection.end ? marker.length : 0,
  );
  return { ...result, markActive };
}

function* formatCaretMarkSteps(
  source: string,
  selection: TextSourceRange,
  request: {
    spans: readonly TextMarkSpan[];
    tokens: readonly TextInlineToken[];
    caretBlock: TextSourceRange | undefined;
    mark: TextMarkdownMark;
    desired: boolean | undefined;
    marker: string;
  },
): Generator<void, TextMarkdownFormatResult | undefined> {
  if (selection.start !== selection.end) return undefined;
  const spans = yield* emptyCaretMarkSpansSteps(source, selection, request.caretBlock);
  const context = {
    ...request,
    hasContent: request.tokens.some((token) => /[^*_~]/u.test(token.text)),
  };
  const empty = yield* formatEmptyCaretMarkSteps(source, selection, spans, context);
  if (empty || spans.length) return empty;
  return yield* toggleAdjacentCaretMarksSteps(source, selection, request.spans, request);
}

function* formatEmptyCaretMarkSteps(
  source: string,
  selection: TextSourceRange,
  spans: readonly TextMarkSpan[],
  request: {
    mark: TextMarkdownMark;
    desired: boolean | undefined;
    caretBlock: TextSourceRange | undefined;
    hasContent: boolean;
  },
): Generator<void, TextMarkdownFormatResult | undefined> {
  if (!spans.length) return undefined;
  const active = spans.filter((span) => span.mark === request.mark);
  if (!active.length)
    return request.desired === false
      ? { source, selection, changes: [], markActive: false }
      : undefined;
  const changes = active.flatMap((span) => [
    { start: span.start, end: span.contentStart, insert: "" },
    { start: span.contentEnd, end: span.end, insert: "" },
  ]);
  const result = yield* applyFormatChanges(source, selection, changes, 0);
  const rejoins =
    request.hasContent &&
    request.caretBlock !== undefined &&
    (yield* caretSourceMarkActiveSteps(result, request.mark, {
      start: request.caretBlock.start,
      end: request.caretBlock.end + result.source.length - source.length,
    }));
  const markActive = Boolean(rejoins);
  if (request.desired !== undefined && request.desired !== markActive)
    return { source, selection, changes: [], markActive: request.desired };
  return { ...result, markActive };
}

function* caretSourceMarkActiveSteps(
  result: TextMarkdownEditResult,
  mark: TextMarkdownMark,
  block: TextSourceRange,
): Generator<void, boolean> {
  const parsed = yield* parseTextInlineSteps(result.source.slice(block.start, block.end));
  const caret = result.selection.start - block.start;
  return parsed.spans.some(
    (span) => span.mark === mark && span.contentStart <= caret && span.contentEnd >= caret,
  );
}

function* toggleAdjacentCaretMarksSteps(
  source: string,
  selection: TextSourceRange,
  spans: readonly TextMarkSpan[],
  request: {
    readonly mark: TextMarkdownMark;
    readonly desired: boolean | undefined;
    readonly marker: string;
  },
): Generator<void, TextMarkdownFormatResult | undefined> {
  const { mark, desired, marker } = request;
  if (
    mark === "code" ||
    selection.start !== selection.end ||
    source.slice(selection.start - marker.length, selection.start) !== marker ||
    source.slice(selection.start, selection.start + marker.length) !== marker
  )
    return undefined;
  const markActive =
    spans.some((span) => span.mark === mark && span.end === selection.start) &&
    spans.some((span) => span.mark === mark && span.start === selection.start);
  if (desired !== undefined && !markActive) return undefined;
  if (desired === false) return { source, selection, changes: [], markActive: false };
  const changes = [
    { start: selection.start - marker.length, end: selection.start + marker.length, insert: "" },
  ];
  return { ...(yield* applyFormatChanges(source, selection, changes, 0)), markActive };
}

function formattingAction(
  tokens: readonly TextInlineToken[],
  spans: readonly TextMarkSpan[],
  selection: TextSourceRange,
  request: { mark: TextMarkdownMark; desired: boolean | undefined },
): {
  action: "none" | "caret" | "add" | "remove";
  active: readonly TextMarkSpan[];
  markActive: boolean;
} {
  const { mark, desired } = request;
  if (desired !== undefined && !tokens.length && selection.start !== selection.end)
    return { action: "none", active: [], markActive: false };
  if (selection.start === selection.end) {
    const active = spans.filter(
      (span) =>
        span.mark === mark &&
        span.contentStart <= selection.start &&
        span.contentEnd >= selection.start,
    );
    if (desired !== undefined && Boolean(active.length) === desired)
      return { action: "none", active, markActive: desired };
    return { action: active.length ? "caret" : "add", active, markActive: active.length === 0 };
  }
  const selected = tokens.filter(
    (token) =>
      token.end > selection.start &&
      token.start < selection.end &&
      (desired === undefined ? token.text.length : token.text.trim().length),
  );
  const allMarked = selected.length > 0 && selected.every((token) => token.marks.includes(mark));
  if (
    desired !== undefined &&
    (desired ? allMarked : !selected.some((token) => token.marks.includes(mark)))
  )
    return { action: "none", active: [], markActive: desired };
  const remove = desired === undefined ? allMarked : !desired;
  return { action: remove ? "remove" : "add", active: [], markActive: !remove };
}

function trimFormattingRange(source: string, selection: TextSourceRange): TextSourceRange {
  const selected = source.slice(selection.start, selection.end);
  const leading = selected.length - selected.trimStart().length;
  const trailing = selected.length - selected.trimEnd().length;
  return {
    start: selection.start + leading,
    end: Math.max(selection.start + leading, selection.end - trailing),
  };
}

function* toggleCaretMark(
  source: string,
  selection: TextSourceRange,
  active: readonly TextMarkSpan[],
): Generator<void, TextMarkdownEditResult> {
  const boundary = active.find(
    (span) => span.contentStart === selection.start || span.contentEnd === selection.start,
  );
  if (boundary) {
    const position = boundary.contentStart === selection.start ? boundary.start : boundary.end;
    return { source, selection: { start: position, end: position }, changes: [] };
  }
  const nested = [...active].sort((a, b) => b.start - a.start);
  const closing = nested.map((span) => source.slice(span.contentEnd, span.end)).join("");
  const opening = nested
    .reverse()
    .map((span) => source.slice(span.start, span.contentStart))
    .join("");
  const change = { ...selection, insert: closing + opening };
  const result = yield* applyFormatChanges(source, selection, [change], 0);
  const position = selection.start + closing.length;
  return { ...result, selection: { start: position, end: position } };
}

function* formattingSourceSteps(
  source: string,
  selection: TextSourceRange,
  document?: TextMarkdownFormattingSource,
) {
  const tokens: TextInlineToken[] = [];
  const spans: TextMarkSpan[] = [];
  const additions: TextSourceRange[] = [];
  let caretBlock: TextSourceRange | undefined;
  const blocks =
    document?.source === source ? document.blocks : yield* textBlockSourcesSteps(source);
  let index = firstSelectedBlock(blocks, selection.start);
  for (; index < blocks.length && blocks[index]!.start <= selection.end; index += 1) {
    const block = blocks[index]!;
    if (block.kind === "math") continue;
    if (
      selection.start === selection.end &&
      selection.start >= block.contentStart &&
      selection.start <= block.contentEnd
    )
      caretBlock = { start: block.contentStart, end: block.contentEnd };
    const parsed =
      "runs" in block
        ? yield* cachedInlineSteps(block)
        : yield* parseTextInlineSteps(source, block.contentStart, block.contentEnd);
    for (const token of parsed.tokens) tokens.push(token);
    for (const span of parsed.spans) spans.push(span);
    const start = Math.max(selection.start, block.contentStart);
    const end = Math.min(selection.end, block.contentEnd);
    if (
      start < end ||
      (selection.start === selection.end &&
        selection.start >= block.start &&
        selection.start <= block.end)
    )
      additions.push({ start, end: Math.max(start, end) });
    yield;
  }
  return { tokens, spans, additions, caretBlock };
}

export function firstSelectedBlock(blocks: readonly TextSourceRange[], start: number): number {
  let lower = 0;
  let upper = blocks.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (blocks[middle]!.end < start) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function* cachedInlineSteps(block: TextMarkdownBlock) {
  const events = block.spans
    .flatMap((span) => [
      { position: span.contentStart, mark: span.mark, delta: 1 },
      { position: span.contentEnd, mark: span.mark, delta: -1 },
    ])
    .sort((a, b) => a.position - b.position);
  const active = new Map<TextMarkdownMark, number>();
  let eventIndex = 0;
  const tokens: TextInlineToken[] = [];
  for (const run of block.runs) {
    while (eventIndex < events.length && events[eventIndex]!.position <= run.contentStart) {
      const event = events[eventIndex++]!;
      const count = (active.get(event.mark) ?? 0) + event.delta;
      if (count > 0) active.set(event.mark, count);
      else active.delete(event.mark);
      yield;
    }
    tokens.push({ ...run, marks: [...active.keys()] });
    yield;
  }
  return { tokens, spans: block.spans };
}

function hasVisibleContent(
  tokens: readonly TextInlineToken[],
  start: number,
  end: number,
): boolean {
  let lower = 0;
  let upper = tokens.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (tokens[middle]!.end <= start) lower = middle + 1;
    else upper = middle;
  }
  return lower < tokens.length && tokens[lower]!.start < end;
}

function markDelimiter(mark: TextMarkdownMark, selected: string): string {
  if (mark === "bold") return "**";
  if (mark === "italic") return "*";
  if (mark === "strikethrough") return "~~";
  let longest = 0;
  let current = 0;
  for (const character of selected) {
    current = character === "`" ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return "`".repeat(longest + 1);
}

function* applyFormatChanges(
  source: string,
  selection: TextSourceRange,
  changes: readonly TextSourceChange[],
  caretOffset: number,
): Generator<void, TextMarkdownEditResult> {
  const atPosition = new Map<number, TextSourceChange>();
  for (const change of changes) {
    const existing = atPosition.get(change.start);
    atPosition.set(change.start, {
      start: change.start,
      end: Math.max(change.end, existing?.end ?? change.start),
      insert: (existing?.insert ?? "") + change.insert,
    });
    yield;
  }
  const ordered = [...atPosition.values()].sort((a, b) => b.start - a.start);
  const pieces: string[] = [];
  let right = source.length;
  let start = selection.start;
  let end = selection.end;
  for (const change of ordered) {
    pieces.push(source.slice(change.end, right), change.insert);
    right = change.start;
    start = rebaseTextPosition(start, change, 1);
    end = rebaseTextPosition(end, change, -1);
    yield;
  }
  pieces.push(source.slice(0, right));
  const formatted = pieces.reverse().join("");
  if (formatted.length > MAX_TEXT_SOURCE_LENGTH)
    throw new RangeError("Text source capacity exceeded.");
  if (caretOffset) start = end = start - caretOffset;
  return {
    source: formatted,
    selection: { start, end: Math.max(start, end) },
    changes: ordered,
  };
}
