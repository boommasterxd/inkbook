import type { TextSourceRange } from "../../../domain/text/text-types";

export interface TextMathSyntaxToken extends TextSourceRange {
  readonly className: string;
}

/** Source highlighting follows the observed native TeX classes without a host-language dependency. */
export function* textMathSyntaxSteps(
  source: string,
  start: number,
  end: number,
): Generator<void, TextMathSyntaxToken[]> {
  const tokens: TextMathSyntaxToken[] = [];
  const expression = /\\(?:[A-Za-z]+|[^\r\n])|%[^\r\n]*|[A-Za-z]+|\d+(?:\.\d+)?|[()[\]{}]|[_&^]/gu;
  for (const match of source.slice(start, end).matchAll(expression)) {
    const position = start + match.index;
    tokens.push({
      start: position,
      end: position + match[0].length,
      className: mathTokenClass(match[0]),
    });
    yield;
  }
  return tokens;
}

function mathTokenClass(text: string): string {
  if (text.startsWith("\\") || /^[\^_&]$/u.test(text)) return "cm-math cm-tag";
  if (text.startsWith("%")) return "cm-math cm-comment";
  if (/^\d/u.test(text)) return "cm-math cm-number";
  return /^[()[\]{}]$/u.test(text) ? "cm-bracket cm-math" : "cm-math cm-variable-2";
}
