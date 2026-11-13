import type { TextInlineToken, TextMarkdownMark, TextMarkSpan } from "./text-types";

interface Token {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly delimiter?: string;
  readonly kind?: "math" | "code";
  readonly contentStart?: number;
  readonly contentEnd?: number;
  readonly display?: boolean;
}

interface Delimiter {
  readonly start: number;
  end: number;
  readonly character: string;
}

export interface TextInlineResult {
  readonly tokens: readonly TextInlineToken[];
  readonly spans: readonly TextMarkSpan[];
}

const SYNTAX = new Set(["*", "_", "~", "`", "$"]);
const ESCAPABLE = new Set([...SYNTAX, "\\", "#", "[", "]", "(", ")", "+", "-", ".", "!", "|"]);

/** Yield points are admission opportunities for the injected shared work scheduler. */
export function* parseTextInlineSteps(
  source: string,
  start = 0,
  end = source.length,
): Generator<void, TextInlineResult> {
  const raw = yield* tokenize(source, start, end);
  const { tokens, spans } = yield* opaqueTokens(source, raw);
  const paired = yield* pairMarks(source, tokens);
  for (const span of paired.spans) {
    spans.push(span);
    yield;
  }
  const active = new Map<TextMarkdownMark, number>();
  const result: TextInlineToken[] = [];
  for (const token of paired.tokens) {
    const transition = paired.transitions.get(token.start);
    if (transition) {
      applyMarkTransition(active, transition);
    } else {
      result.push({
        start: token.start,
        end: token.end,
        contentStart: token.contentStart ?? token.end - token.text.length,
        contentEnd: token.contentEnd ?? token.end,
        text: token.text,
        kind: token.kind === "math" ? "math" : "text",
        ...(token.kind === "math" ? { display: token.display ?? false } : {}),
        marks: token.kind === "code" ? [...active.keys(), "code"] : [...active.keys()],
      });
    }
    yield;
  }
  return { tokens: result, spans };
}

function applyMarkTransition(
  active: Map<TextMarkdownMark, number>,
  transition: { mark?: TextMarkdownMark; open: boolean },
): void {
  if (!transition.mark) return;
  const count = (active.get(transition.mark) ?? 0) + (transition.open ? 1 : -1);
  if (count > 0) active.set(transition.mark, count);
  else active.delete(transition.mark);
}

function* tokenize(source: string, start: number, end: number): Generator<void, Token[]> {
  const tokens: Token[] = [];
  let position = start;
  while (position < end) {
    const from = position;
    const character = source[position]!;
    if (
      character === "\\" &&
      (ESCAPABLE.has(source[position + 1] ?? "") || source[position + 1] === "\n")
    ) {
      position += 2;
      tokens.push({ start: from, end: position, text: source[from + 1]! });
    } else if (SYNTAX.has(character)) {
      while (position < end && source[position] === character) {
        position += 1;
        if (position % 256 === 0) yield;
      }
      const delimiter = source.slice(from, position);
      tokens.push({ start: from, end: position, text: delimiter, delimiter });
    } else {
      do {
        position += 1;
        if (position % 256 === 0) yield;
      } while (position < end && !SYNTAX.has(source[position]!) && source[position] !== "\\");
      tokens.push({ start: from, end: position, text: source.slice(from, position) });
    }
    yield;
  }
  return tokens;
}

function* opaqueTokens(source: string, raw: readonly Token[]) {
  const next = new Map<number, number>();
  const previous = new Map<string, number>();
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    yield;
    const delimiter = raw[index]!.delimiter;
    if (!delimiter || (delimiter[0] !== "`" && delimiter !== "$" && delimiter !== "$$")) continue;
    const match = previous.get(delimiter);
    if (match !== undefined) next.set(index, match);
    previous.set(delimiter, index);
  }
  const tokens: Token[] = [];
  const spans: TextMarkSpan[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    yield;
    const opening = raw[index]!;
    const closingIndex = next.get(index);
    if (closingIndex === undefined) {
      tokens.push(opening);
      continue;
    }
    const closing = raw[closingIndex]!;
    const kind = opening.delimiter![0] === "`" ? "code" : "math";
    tokens.push({
      start: opening.start,
      end: closing.end,
      text: source.slice(opening.end, closing.start),
      kind,
      contentStart: opening.end,
      contentEnd: closing.start,
      ...(kind === "math" ? { display: opening.delimiter === "$$" } : {}),
    });
    if (kind === "code")
      spans.push({
        start: opening.start,
        end: closing.end,
        contentStart: opening.end,
        contentEnd: closing.start,
        mark: "code",
      });
    index = closingIndex;
  }
  return { tokens, spans };
}

function* pairMarks(source: string, tokens: readonly Token[]) {
  const stack: Delimiter[] = [];
  const expanded: Token[] = [];
  const spans: TextMarkSpan[] = [];
  const transitions = new Map<number, { mark?: TextMarkdownMark; open: boolean }>();
  for (const token of tokens) {
    const character = token.delimiter?.[0];
    if (character !== "*" && character !== "_" && character !== "~") {
      expanded.push(token);
      continue;
    }
    yield* pairToken({ source, token, character, stack, expanded, transitions, spans });
  }
  return { tokens: expanded, spans, transitions };
}

interface PairTokenContext {
  readonly source: string;
  readonly token: Token;
  readonly character: string;
  readonly stack: Delimiter[];
  readonly expanded: Token[];
  readonly transitions: Map<number, { mark?: TextMarkdownMark; open: boolean }>;
  readonly spans: TextMarkSpan[];
}

function* pairToken(context: PairTokenContext): Generator<void> {
  const { source, token, character, stack, expanded, transitions, spans } = context;
  const flanking = delimiterFlanking(source, token, character);
  let offset = token.start;
  for (let position = token.start; position < token.end; position += 1) {
    expanded.push({ start: position, end: position + 1, text: character });
    yield;
  }
  while (offset < token.end) {
    const top = stack[stack.length - 1];
    const remaining = token.end - offset;
    const closes = flanking.close && top?.character === character;
    if (!closes || (character === "~" && (remaining < 2 || top.end - top.start < 2))) break;
    const length = remaining >= 2 && top.end - top.start >= 2 ? 2 : 1;
    const mark = delimiterMark(character, length);
    const opening = top.end - length;
    for (let part = 0; part < length; part += 1) {
      transitions.set(opening + part, part === 0 ? { mark, open: true } : { open: true });
      transitions.set(offset + part, part === 0 ? { mark, open: false } : { open: false });
    }
    spans.push({
      start: opening,
      end: offset + length,
      contentStart: top.end,
      contentEnd: offset,
      mark,
    });
    top.end = opening;
    if (top.start === top.end) stack.pop();
    offset += length;
    yield;
  }
  if (offset < token.end && flanking.open) stack.push({ start: offset, end: token.end, character });
}

function delimiterMark(character: string, length: number): TextMarkdownMark {
  if (character === "~") return "strikethrough";
  return length === 2 ? "bold" : "italic";
}

function delimiterFlanking(source: string, token: Token, character: string) {
  const before = source[token.start - 1] ?? " ";
  const after = source[token.end] ?? " ";
  const intraword =
    character === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
  return { open: !intraword && !/\s/u.test(after), close: !intraword && !/\s/u.test(before) };
}
