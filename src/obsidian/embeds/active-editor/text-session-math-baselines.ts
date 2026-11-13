import {
  canonicalizeGeometryNumber,
  type TextElementV2,
  type TextLayoutLineV2,
  type TextLayoutV2,
  type TextMathLayoutV2,
} from "../../../domain/schema/public";
import { textBlockBaseStyle } from "../../../domain/text/text-layout-style";
import type {
  TextMarkdownBlock,
  TextMarkdownDocument,
  TextSourceRange,
} from "../../../domain/text/text-types";
import type {
  CanvasTextMeasurer,
  TextFontMeasurement,
} from "../../../rendering/text/canvas-text-measurer";
import { blockTextStyle } from "../../../rendering/text/text-layout-atoms";
import { collectTextGlyphStruts } from "../../../rendering/text/text-layout-strut";
import {
  admitTextLayout,
  type ResolvedTextMath,
  type TextLayoutPorts,
  type TextMeasurer,
} from "../../../rendering/text/text-layout-types";

// A stored coordinate has three decimal places; comparisons combine up to three coordinates.
const GEOMETRY_TOLERANCE = 0.002;

interface RetainedMathLine {
  readonly line: TextLayoutLineV2;
  readonly fonts: TextFontMeasurement[];
  ascent: number;
  mathAscent: number;
}

interface RetainedMath {
  readonly math: TextMathLayoutV2;
  readonly row: RetainedMathLine;
}

type MathBaselinePorts = Pick<TextLayoutPorts, "scheduler" | "signal"> & {
  readonly measure: TextMeasurer;
  readonly native: CanvasTextMeasurer;
};

/** Retains saved baselines without relaying native DOM measurements into decoration updates. */
export class TextSessionMathBaselines {
  #entries = new Map<number, RetainedMath>();
  #element: TextElementV2 | undefined;
  #version = 0;

  public async open(
    element: TextElementV2,
    document: TextMarkdownDocument,
    ports: MathBaselinePorts,
  ): Promise<void> {
    this.clear();
    const version = this.#version;
    if (!element.layout.math?.length) return;
    const { retained, lines } = await retainedMathIndex(element, ports);
    const struts = await collectTextGlyphStruts(document, ports);
    const rows = new Map<TextLayoutLineV2, RetainedMathLine>();
    const entries = new Map<number, RetainedMath>();
    for (const block of document.blocks) {
      await admitTextLayout(ports);
      if (block.table) continue;
      const strut = struts.blocks.get(block);
      const style =
        strut?.style ??
        blockTextStyle(block, textBlockBaseStyle(element.style, block.kind === "heading"));
      const fontResourceId =
        strut?.fontResourceId ??
        struts.first?.fontResourceId ??
        ports.measure.resolveFontResourceId?.(style);
      await bindRetainedMathBlock(
        block,
        {
          element,
          strut: { style, ...(fontResourceId ? { fontResourceId } : {}) },
        },
        { retained, lines, rows, entries },
        ports,
      );
    }
    await ports.native.prepareLineMetrics(
      (function* () {
        for (const row of rows.values()) yield* row.fonts;
      })(),
      ports,
    );
    for (const row of rows.values()) {
      for (const font of row.fonts) {
        await admitTextLayout(ports);
        row.ascent = Math.max(
          row.ascent,
          ports.native.measure("", font.style, font.fontResourceId).ascent,
        );
      }
    }
    await admitTextLayout(ports);
    if (this.#version !== version) return;
    this.#element = element;
    this.#entries = entries;
  }

  public offset(range: TextSourceRange, result: ResolvedTextMath, layout?: TextLayoutV2): number {
    if (layout !== undefined && layout !== this.#element?.layout) return 0;
    const entry = this.#entries.get(range.start);
    if (!entry || entry.math.end !== range.end) return 0;
    const { math, row } = entry;
    const savedAscent = row.line.y + row.line.baseline - math.y;
    if (
      Math.abs(math.width - result.width) > GEOMETRY_TOLERANCE ||
      Math.abs(math.height - result.height) > GEOMETRY_TOLERANCE ||
      Math.abs(savedAscent - result.ascent) > GEOMETRY_TOLERANCE
    )
      return 0;
    const offset = canonicalizeGeometryNumber(
      row.line.baseline - Math.max(row.ascent, row.mathAscent, result.ascent),
    );
    return Math.abs(offset) <= GEOMETRY_TOLERANCE ? 0 : offset;
  }

  public clear(): void {
    this.#version += 1;
    this.#element = undefined;
    this.#entries.clear();
  }

  public adopt(element: TextElementV2): void {
    const previous = this.#element;
    if (
      previous?.layout !== element.layout ||
      previous.width !== element.width ||
      previous.source !== element.source ||
      previous.style !== element.style ||
      previous.ranges !== element.ranges ||
      previous.paragraphs !== element.paragraphs
    )
      this.clear();
  }
}

async function bindRetainedMathBlock(
  block: TextMarkdownBlock,
  request: { readonly element: TextElementV2; readonly strut: TextFontMeasurement },
  index: {
    readonly retained: ReadonlyMap<number, TextMathLayoutV2>;
    readonly lines: readonly TextLayoutLineV2[];
    readonly rows: Map<TextLayoutLineV2, RetainedMathLine>;
    readonly entries: Map<number, RetainedMath>;
  },
  ports: MathBaselinePorts,
): Promise<void> {
  for (const run of block.runs) {
    await admitTextLayout(ports);
    if (run.kind !== "math") continue;
    const math = index.retained.get(run.start);
    if (!math || math.end !== run.end) continue;
    const line = retainedMathLine(index.lines, math);
    if (!line) continue;
    let row = index.rows.get(line);
    if (!row) {
      row = { line, fonts: [request.strut], ascent: 0, mathAscent: 0 };
      for (const part of line.runs) {
        await admitTextLayout(ports);
        row.fonts.push({
          style: { ...request.element.style, ...part.style },
          ...(part.fontResourceId ? { fontResourceId: part.fontResourceId } : {}),
        });
      }
      index.rows.set(line, row);
    }
    if (!math.display) {
      const style = blockTextStyle(block, run.style);
      const id = ports.measure.resolveFontResourceId?.(style);
      row.fonts.push({ style, ...(id ? { fontResourceId: id } : {}) });
    }
    row.mathAscent = Math.max(row.mathAscent, line.y + line.baseline - math.y);
    index.entries.set(math.start, { math, row });
  }
}

async function retainedMathIndex(element: TextElementV2, ports: MathBaselinePorts) {
  const retained = new Map<number, TextMathLayoutV2>();
  const lines: TextLayoutLineV2[] = [];
  for (const math of element.layout.math ?? []) {
    await admitTextLayout(ports);
    retained.set(math.start, math);
  }
  const tables = element.layout.tables ?? [];
  let tableIndex = 0;
  for (const line of element.layout.lines) {
    await admitTextLayout(ports);
    while (tables[tableIndex] && line.y >= tables[tableIndex]!.y + tables[tableIndex]!.height)
      tableIndex += 1;
    const table = tables[tableIndex];
    // Table cells may reset y within a row. The remaining block lines are already ordered.
    if (!table || line.y < table.y) lines.push(line);
  }
  return { retained, lines };
}

function retainedMathLine(
  lines: readonly TextLayoutLineV2[],
  math: TextMathLayoutV2,
): TextLayoutLineV2 | undefined {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]!.y <= math.y + GEOMETRY_TOLERANCE) low = middle + 1;
    else high = middle;
  }
  const line = lines[low - 1];
  return line &&
    math.x >= line.x - GEOMETRY_TOLERANCE &&
    math.x + math.width <= line.x + line.width + GEOMETRY_TOLERANCE &&
    math.y + math.height <= line.y + line.height + GEOMETRY_TOLERANCE
    ? line
    : undefined;
}
