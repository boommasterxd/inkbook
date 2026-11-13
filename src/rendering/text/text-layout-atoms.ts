import type { TextStyleV2 } from "../../domain/schema/public";
import type { TextMarkdownBlock, TextMarkdownRun } from "../../domain/text/text-types";
import {
  TEXT_CODE_FONT_FAMILY,
  TEXT_LIST_INDENT_EM,
  textBlockStyle,
} from "../../domain/text/text-layout-style";
import { TextMathSyntaxError } from "./text-math-syntax-error";
import {
  admitTextLayout,
  assertTextLayoutActive,
  type MeasuredText,
  type ResolvedTextMath,
  type TextLayoutPorts,
} from "./text-layout-types";

export interface TextLayoutAtom extends MeasuredText {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly style: TextStyleV2;
  readonly whitespace: boolean;
  readonly newline: boolean;
  readonly continuation?: boolean;
  readonly tab?: boolean;
  readonly math?: ResolvedTextMath;
  readonly display?: boolean;
}

const MAX_MEASUREMENT_CHARACTERS = 256;

export function blockTextStyle(
  block: TextMarkdownBlock,
  style: TextStyleV2,
  code = false,
): TextStyleV2 {
  return textBlockStyle(
    style,
    block.kind === "heading" ? (block.headingLevel ?? 1) : undefined,
    code,
  );
}

export async function* textLayoutAtoms(
  block: TextMarkdownBlock,
  ports: TextLayoutPorts,
  width?: number,
  source = "",
): AsyncGenerator<TextLayoutAtom> {
  for (const run of block.runs) {
    const style = blockTextStyle(block, run.style, run.code);
    if (run.kind === "math") {
      yield* mathRunAtoms(block, run, style, ports, { width, source });
    } else yield* textRunAtoms(run, style, ports);
  }
}

async function* mathRunAtoms(
  block: TextMarkdownBlock,
  run: TextMarkdownRun,
  style: TextStyleV2,
  ports: TextLayoutPorts,
  context: { readonly width: number | undefined; readonly source: string },
): AsyncGenerator<TextLayoutAtom> {
  try {
    if (!ports.math) throw new Error("Math rendering is unavailable.");
    await admitTextLayout(ports);
    const math = await ports.math.resolve(
      run.latex ?? run.text,
      run.display ?? block.kind === "math",
      style.fontSize,
      ports.signal,
      context.width === undefined
        ? undefined
        : Math.max(
            0,
            context.width -
              (block.list ? run.style.fontSize * TEXT_LIST_INDENT_EM * (block.list.depth + 1) : 0),
          ),
      { bold: style.bold },
    );
    await admitTextLayout(ports);
    yield {
      ...math,
      text: "",
      start: run.start,
      end: run.end,
      style,
      whitespace: false,
      newline: false,
      math,
      display: run.display ?? block.kind === "math",
    };
  } catch (error) {
    assertTextLayoutActive(ports.signal);
    if (!(error instanceof TextMathSyntaxError)) throw error;
    const literal = context.source.slice(run.start, run.end);
    if (literal.length !== run.end - run.start) throw new Error("Math source is unavailable.");
    yield* textRunAtoms(
      {
        ...run,
        kind: "text",
        text: literal,
        contentStart: run.start,
        contentEnd: run.end,
        code: true,
      },
      { ...style, fontFamily: TEXT_CODE_FONT_FAMILY },
      ports,
    );
  }
}

async function* textRunAtoms(
  run: TextMarkdownRun,
  style: TextStyleV2,
  ports: TextLayoutPorts,
): AsyncGenerator<TextLayoutAtom> {
  for (const token of run.text.matchAll(/\r?\n|\t|[^\S\r\n\t]+|[^\s]+/gu)) {
    const text = token[0];
    for (let offset = 0; offset < text.length;) {
      await admitTextLayout(ports);
      let end = Math.min(text.length, offset + MAX_MEASUREMENT_CHARACTERS);
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
      for (const fragment of fontBindingFragments(
        run,
        (token.index ?? 0) + offset,
        end - offset,
        ports,
      )) {
        await admitTextLayout(ports);
        const raw = run.text.slice(fragment.textStart, fragment.textEnd);
        const part = raw === "\t" ? " " : raw;
        const fontResourceId = ports.measure.resolveFontResourceId?.(style, fragment.range);
        yield {
          ...ports.measure.measure(part, style, fontResourceId),
          ...(fontResourceId === undefined ? {} : { fontResourceId }),
          text: part,
          ...fragment.range,
          style,
          whitespace: /^\s+$/u.test(part),
          newline: /^\r?\n$/u.test(part),
          continuation: fragment.textStart > (token.index ?? 0),
          ...(raw === "\t" ? { tab: true } : {}),
        };
      }
      offset = end;
    }
  }
}

function* fontBindingFragments(
  run: TextMarkdownRun,
  offset: number,
  length: number,
  ports: TextLayoutPorts,
) {
  const range = runSourceRange(run, offset, length);
  let position = offset;
  if (range.end - range.start === length) {
    for (const boundary of ports.measure.fontResourceBoundaries?.(range.start, range.end) ?? []) {
      if (boundary <= range.start || boundary >= range.end) continue;
      const next = offset + boundary - range.start;
      if (!Number.isInteger(boundary) || next <= position)
        throw new Error("Invalid font binding boundary.");
      yield {
        textStart: position,
        textEnd: next,
        range: runSourceRange(run, position, next - position),
      };
      position = next;
    }
  }
  yield {
    textStart: position,
    textEnd: offset + length,
    range: runSourceRange(run, position, offset + length - position),
  };
}

function runSourceRange(
  run: TextMarkdownRun,
  offset: number,
  length: number,
): { start: number; end: number } {
  if (run.contentEnd - run.contentStart === run.text.length)
    return { start: run.contentStart + offset, end: run.contentStart + offset + length };
  return { start: run.start, end: run.end };
}
