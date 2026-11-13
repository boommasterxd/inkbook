import type {
  TextLayoutLineV2,
  TextLayoutRunV2,
  TextMathLayoutV2,
  TextStyleV2,
} from "../../domain/schema/public";
import { canonicalizeGeometryNumber as canonical } from "../../domain/schema/canonical";
import type { TextMarkdownBlock } from "../../domain/text/text-types";
import { textBlockAlignmentAt } from "../../domain/text/text-paragraph-alignment";
import {
  TEXT_LINE_HEIGHT,
  TEXT_LIST_INDENT_EM,
  TEXT_LIST_MARKER_GAP_EM,
  TEXT_TAB_SIZE,
} from "../../domain/text/text-layout-style";
import type { TextLayoutAtom } from "./text-layout-atoms";
import {
  admitTextLayout,
  type MeasuredText,
  type TextLayoutPorts,
  type TextLineStrut,
} from "./text-layout-types";

export class TextLineBuilder {
  readonly lines: TextLayoutLineV2[] = [];
  readonly math: TextMathLayoutV2[] = [];
  readonly #atoms: TextLayoutAtom[] = [];
  readonly #block: TextMarkdownBlock;
  readonly #style: TextStyleV2;
  readonly #ports: TextLayoutPorts;
  readonly #indent: number;
  readonly #available: number;
  readonly #strut: MeasuredText;
  readonly #strutStyle: TextStyleV2;
  public readonly strutFontResourceId: string | undefined;
  #width = 0;
  #top: number;
  #sourcePosition: number;

  public constructor(
    block: TextMarkdownBlock,
    width: number,
    top: number,
    style: TextStyleV2,
    ports: TextLayoutPorts,
    strut?: TextLineStrut,
  ) {
    this.#block = block;
    this.#sourcePosition = block.start;
    this.#style = style;
    this.#ports = ports;
    this.#strutStyle = strut?.style ?? style;
    const strutBinding =
      strut?.fontResourceId ??
      ports.measure.resolveFontResourceId?.(this.#strutStyle, {
        start: block.contentStart,
        end: block.contentStart,
      });
    this.#strut = ports.measure.measure("", this.#strutStyle, strutBinding);
    this.strutFontResourceId = strutBinding ?? this.#strut.fontResourceId;
    this.#top = top;
    this.#indent = block.list ? style.fontSize * TEXT_LIST_INDENT_EM * (block.list.depth + 1) : 0;
    this.#available = Math.max(1, width - this.#indent);
  }

  public async append(atom: TextLayoutAtom): Promise<void> {
    if (atom.newline) {
      this.#flush(true);
      this.#sourcePosition = atom.end;
      return;
    }
    if (atom.tab) atom = { ...atom, width: tabAdvance(this.#width, atom.width) };
    if (
      this.#width + atom.width > this.#available &&
      !atom.whitespace &&
      this.#atoms.length &&
      !atom.continuation
    )
      this.#flush(false);
    if (
      (atom.width > this.#available ||
        ((atom.continuation || atom.whitespace) && this.#width + atom.width > this.#available)) &&
      !atom.tab &&
      !atom.math
    ) {
      await this.#splitWord(atom);
      return;
    }
    this.#atoms.push(atom);
    this.#width += atom.width;
  }

  public finish(): number {
    if (this.#atoms.length || this.lines.length === 0) this.#flush(true);
    return this.#top;
  }

  async #splitWord(atom: TextLayoutAtom): Promise<void> {
    const characters = graphemes(atom.text);
    let cursor = 0;
    let sourceOffset = 0;
    while (cursor < characters.length) {
      await admitTextLayout(this.#ports);
      const fitting = this.#fittingCount(characters, cursor, atom.style, atom.fontResourceId);
      if (fitting === 0 && this.#atoms.length) {
        this.#flush(false);
        continue;
      }
      const count = Math.max(1, fitting);
      const text = characters.slice(cursor, cursor + count).join("");
      const start =
        atom.end - atom.start === atom.text.length ? atom.start + sourceOffset : atom.start;
      const end = atom.end - atom.start === atom.text.length ? start + text.length : atom.end;
      const part = {
        ...atom,
        ...this.#ports.measure.measure(text, atom.style, atom.fontResourceId),
        text,
        start,
        end,
      };
      this.#atoms.push(part);
      this.#width += part.width;
      cursor += count;
      sourceOffset += text.length;
      if (cursor < characters.length) this.#flush(false);
    }
  }

  #fittingCount(
    characters: readonly string[],
    start: number,
    style: TextStyleV2,
    fontResourceId?: string,
  ): number {
    let low = 0;
    let high = characters.length - start;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const width = this.#ports.measure.measure(
        characters.slice(start, start + middle).join(""),
        style,
        fontResourceId,
      ).width;
      if (width <= this.#available - this.#width) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  #flush(last: boolean): void {
    const marker = this.lines.length === 0 ? this.#prepareMarker() : undefined;
    const dimensions = lineDimensions(this.#atoms, this.#strutStyle, this.#strut, marker);
    const alignment = textBlockAlignmentAt(this.#block, this.#sourcePosition);
    const justified = alignment === "justify" && !last;
    const spaces = justified ? this.#atoms.filter((atom) => atom.whitespace).length : 0;
    const extra = spaces ? Math.max(0, this.#available - this.#width) / spaces : 0;
    const offset =
      alignment === "right"
        ? this.#available - this.#width
        : alignment === "center"
          ? (this.#available - this.#width) / 2
          : 0;
    const x = this.#indent + Math.max(0, offset);
    const runs: TextLayoutRunV2[] = [];
    let cursor = 0;
    let previousTab = false;
    for (const atom of this.#atoms) {
      const width = atom.width + (atom.whitespace ? extra : 0);
      if (atom.math)
        this.math.push({
          start: atom.start,
          end: atom.end,
          display: atom.display ?? this.#block.kind === "math",
          x: canonical(x + cursor),
          y: canonical(this.#top + dimensions.baseline - atom.ascent),
          width: canonical(atom.width),
          height: canonical(atom.math.height),
          paths: atom.math.paths,
        });
      else appendTextRun(runs, atom, cursor, width, extra === 0 && !atom.tab && !previousTab);
      previousTab = atom.tab === true;
      cursor += width;
    }
    if (marker) this.#appendMarker(runs, marker);
    this.lines.push({
      x: canonical(x),
      y: canonical(this.#top),
      width: canonical(cursor),
      height: canonical(dimensions.height),
      baseline: canonical(dimensions.baseline),
      runs,
    });
    this.#top += dimensions.height;
    this.#atoms.length = 0;
    this.#width = 0;
  }

  #prepareMarker(): TextLayoutAtom | undefined {
    const list = this.#block.list;
    if (!list) return undefined;
    const text = list.ordered ? `${list.number}.` : "•";
    const fontResourceId = this.#ports.measure.resolveFontResourceId?.(this.#style, {
      start: this.#block.start,
      end: this.#block.contentStart,
    });
    return {
      ...this.#ports.measure.measure(text, this.#style, fontResourceId),
      text,
      start: this.#block.start,
      end: this.#block.contentStart,
      style: this.#style,
      whitespace: false,
      newline: false,
      ...(fontResourceId === undefined ? {} : { fontResourceId }),
    };
  }

  #appendMarker(runs: TextLayoutRunV2[], marker: TextLayoutAtom): void {
    runs.unshift({
      text: marker.text,
      start: marker.start,
      end: marker.end,
      x: canonical(-marker.width - this.#style.fontSize * TEXT_LIST_MARKER_GAP_EM),
      width: canonical(marker.width),
      style: this.#style,
      ...(marker.fontResourceId === undefined ? {} : { fontResourceId: marker.fontResourceId }),
    });
  }
}

function tabAdvance(current: number, space: number): number {
  const stop = space * TEXT_TAB_SIZE;
  if (stop <= 0) return 0;
  const advance = stop - (current % stop);
  return advance <= Number.EPSILON * Math.max(stop, current) * 4 ? stop : advance;
}

function appendTextRun(
  runs: TextLayoutRunV2[],
  atom: TextLayoutAtom,
  x: number,
  width: number,
  merge: boolean,
): void {
  const previous = runs[runs.length - 1];
  if (
    merge &&
    previous?.style === atom.style &&
    previous.end === atom.start &&
    previous.fontResourceId === atom.fontResourceId
  ) {
    previous.text += atom.text;
    previous.end = atom.end;
    previous.width = canonical(x + width - previous.x);
  } else
    runs.push({
      text: atom.text,
      start: atom.start,
      end: atom.end,
      x: canonical(x),
      width: canonical(width),
      style: atom.style,
      ...(atom.fontResourceId === undefined ? {} : { fontResourceId: atom.fontResourceId }),
    });
}

function lineDimensions(
  atoms: readonly TextLayoutAtom[],
  style: TextStyleV2,
  strut: MeasuredText,
  marker?: TextLayoutAtom,
): { height: number; baseline: number } {
  const leading =
    ((strut.lineHeight ?? style.fontSize * TEXT_LINE_HEIGHT) - strut.ascent - strut.descent) / 2;
  const markerLeading = marker
    ? ((marker.lineHeight ?? marker.style.fontSize * TEXT_LINE_HEIGHT) -
        marker.ascent -
        marker.descent) /
      2
    : 0;
  let ascent = Math.max(0, strut.ascent + leading, marker ? marker.ascent + markerLeading : 0);
  let descent = Math.max(0, strut.descent + leading, marker ? marker.descent + markerLeading : 0);
  for (const atom of atoms) {
    const extra = atom.math
      ? 0
      : ((atom.lineHeight ?? atom.style.fontSize * TEXT_LINE_HEIGHT) - atom.ascent - atom.descent) /
        2;
    ascent = Math.max(ascent, atom.ascent + extra);
    descent = Math.max(descent, atom.descent + extra);
  }
  return { height: ascent + descent, baseline: ascent };
}

function graphemes(text: string): string[] {
  const nativeIntl = Intl as typeof Intl & {
    Segmenter?: new (
      locale: undefined,
      options: { granularity: "grapheme" },
    ) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  };
  return nativeIntl.Segmenter
    ? Array.from(
        new nativeIntl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
        (part) => part.segment,
      )
    : Array.from(text);
}
