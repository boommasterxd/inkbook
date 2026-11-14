import type {
  TextMarkdownBlock,
  TextMarkdownDocument,
  TextSourceRange,
} from "../../../domain/text/text-types";
import { textBlockGlyphStrut } from "../../../rendering/text/text-layout-strut";
import { textMathSyntaxSteps, type TextMathSyntaxToken } from "./text-math-syntax";

type PreviewGlyphStrut = ReturnType<typeof textBlockGlyphStrut>;

/** Prefix maxima retain enclosing constructs when the visible range starts inside one. */
class PreviewRangeIndex<Value extends TextSourceRange> {
  public constructor(
    readonly values: readonly Value[],
    readonly ends: readonly number[],
  ) {}

  public *visible(viewport: readonly TextSourceRange[]): Generator<Value> {
    const visited = new Set<Value>();
    for (const visible of viewport) {
      let lower = 0;
      let upper = this.values.length;
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        if (this.ends[middle]! < visible.start) lower = middle + 1;
        else upper = middle;
      }
      for (
        let index = lower;
        index < this.values.length && this.values[index]!.start <= visible.end;
        index += 1
      ) {
        const value = this.values[index]!;
        if (value.end >= visible.start && !visited.has(value)) {
          visited.add(value);
          yield value;
        }
      }
    }
  }
}

interface TextPreviewBlockIndex {
  readonly runs: PreviewRangeIndex<TextMarkdownBlock["runs"][number]>;
  readonly spans: PreviewRangeIndex<TextMarkdownBlock["spans"][number]>;
  readonly glyph: PreviewGlyphStrut;
}

export interface IndexedTextPreview {
  readonly document: TextMarkdownDocument;
  readonly blocks: PreviewRangeIndex<TextMarkdownBlock>;
  readonly content: ReadonlyMap<TextMarkdownBlock, TextPreviewBlockIndex>;
  readonly firstGlyph: PreviewGlyphStrut;
  readonly mathSyntax: ReadonlyMap<
    TextMarkdownBlock["runs"][number],
    PreviewRangeIndex<TextMathSyntaxToken>
  >;
}

export function* indexTextPreviewSteps(
  document: TextMarkdownDocument,
): Generator<void, IndexedTextPreview> {
  const blocks = yield* indexRangesSteps(document.blocks);
  const content = new Map<TextMarkdownBlock, TextPreviewBlockIndex>();
  let firstGlyph: PreviewGlyphStrut;
  const mathSyntax = new Map<
    TextMarkdownBlock["runs"][number],
    PreviewRangeIndex<TextMathSyntaxToken>
  >();
  const prepareRun = (run: TextMarkdownBlock["runs"][number]) =>
    run.kind === "math" ? indexMathSyntaxSteps(document.source, run, mathSyntax) : undefined;
  for (const block of document.blocks) {
    const runs = yield* indexRangesSteps(block.runs, prepareRun);
    const spans = yield* indexRangesSteps(block.spans);
    const glyph = textBlockGlyphStrut(block);
    content.set(block, { runs, spans, glyph });
    firstGlyph ??= glyph;
    yield;
  }
  return { document, blocks, content, firstGlyph, mathSyntax };
}

function* indexMathSyntaxSteps(
  source: string,
  run: TextMarkdownBlock["runs"][number],
  cache: Map<TextMarkdownBlock["runs"][number], PreviewRangeIndex<TextMathSyntaxToken>>,
): Generator<void> {
  const tokens = yield* textMathSyntaxSteps(source, run.contentStart, run.contentEnd);
  cache.set(run, yield* indexRangesSteps(tokens));
}

function* indexRangesSteps<Value extends TextSourceRange>(
  values: readonly Value[],
  prepare?: (value: Value) => Generator<void> | undefined,
): Generator<void, PreviewRangeIndex<Value>> {
  const ends: number[] = [];
  let end = 0;
  for (const value of values) {
    end = Math.max(end, value.end);
    ends.push(end);
    yield;
    const continuation = prepare?.(value);
    if (continuation) yield* continuation;
  }
  return new PreviewRangeIndex(values, ends);
}
