import { parseTextInlineSteps } from "./markdown-inline";
import type { TextInlineToken, TextMarkSpan, TextSourceRange } from "./text-types";

/** The normal parser leaves empty delimiters literal; a local typing probe resolves their scopes. */
export function* emptyCaretMarkSpansSteps(
  source: string,
  selection: TextSourceRange,
  block: TextSourceRange | undefined,
): Generator<void, readonly TextMarkSpan[]> {
  const caret = selection.start;
  const before = source[caret - 1];
  if (
    selection.end !== caret ||
    block === undefined ||
    before !== source[caret] ||
    (before !== "*" && before !== "_" && before !== "~")
  )
    return [];
  const position = caret - block.start;
  const probe = source.slice(block.start, caret) + "x" + source.slice(caret, block.end);
  const parsed = yield* parseTextInlineSteps(probe);
  const emptyContent = yield* caretContentBoundsSteps(parsed.tokens, position, probe.length);
  if (emptyContent === undefined) return [];
  const spans: TextMarkSpan[] = [];
  for (const span of parsed.spans) {
    if (
      span.contentStart <= position &&
      span.contentEnd > position &&
      span.mark !== "code" &&
      span.contentStart >= emptyContent.start &&
      span.contentEnd <= emptyContent.end
    ) {
      const original = (offset: number) => block.start + offset - (offset > position ? 1 : 0);
      spans.push({
        mark: span.mark,
        start: original(span.start),
        end: original(span.end),
        contentStart: original(span.contentStart),
        contentEnd: original(span.contentEnd),
      });
    }
    yield;
  }
  return spans;
}

function* caretContentBoundsSteps(
  tokens: readonly TextInlineToken[],
  position: number,
  length: number,
): Generator<void, TextSourceRange | undefined> {
  let start = 0;
  let end = length;
  for (const token of tokens) {
    if (token.end <= position) start = Math.max(start, token.end);
    else if (token.start >= position + 1) end = Math.min(end, token.start);
    else if (token.start !== position || token.end !== position + 1) return undefined;
    yield;
  }
  return { start, end };
}
