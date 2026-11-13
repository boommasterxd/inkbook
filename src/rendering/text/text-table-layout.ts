import type { TextLayoutLineV2, TextMathLayoutV2, TextStyleV2 } from "../../domain/schema/public";
import { canonicalizeGeometryNumber as canonical } from "../../domain/schema/canonical";
import { MAX_TEXT_LAYOUT_ITEMS } from "../../domain/schema/text-validation-primitives";
import type { TextMarkdownBlock, TextMarkdownTableCell } from "../../domain/text/text-types";
import {
  TEXT_TABLE_BORDER_EM,
  TEXT_TABLE_CELL_PADDING_EM,
  textBlockBaseStyle,
} from "../../domain/text/text-layout-style";
import { TextLineBuilder } from "./text-line-builder";
import { textLayoutAtoms } from "./text-layout-atoms";
import { textBlockGlyphStrut } from "./text-layout-strut";
import { admitTextLayout, type TextLayoutPorts, type PreparedTextTable } from "./text-layout-types";

interface TextTableLayoutRequest {
  readonly width: number;
  readonly top: number;
  readonly style: TextStyleV2;
}

/** All cells reuse the paragraph line builder and its font, wrapping, math and source bindings. */
export async function layoutTextTable(
  block: TextMarkdownBlock,
  request: TextTableLayoutRequest,
  ports: TextLayoutPorts,
  source: string,
): Promise<PreparedTextTable> {
  const descriptor = block.table;
  if (!descriptor || descriptor.alignments.length === 0 || descriptor.rows.length === 0)
    throw new Error("Table source geometry is unavailable.");
  const columns = descriptor.alignments.length;
  if (columns * descriptor.rows.length + columns + 1 > MAX_TEXT_LAYOUT_ITEMS)
    throw new RangeError("Text table exceeds the supported item count.");
  const result: PreparedTextTable = {
    table: {
      start: block.start,
      end: block.end,
      x: 0,
      y: canonical(request.top),
      width: canonical(request.width),
      height: 0,
      columns,
      rowHeights: [],
      borderWidth: canonical(
        Math.min(request.style.fontSize * TEXT_TABLE_BORDER_EM, request.width / columns / 2),
      ),
    },
    lines: [],
    math: [],
    rows: [],
  };
  let runIndex = 0;
  let top = request.top;
  let items = columns + descriptor.rows.length + 1;
  for (const [rowIndex, row] of descriptor.rows.entries()) {
    await admitTextLayout(ports);
    const lineStart = result.lines.length;
    const mathStart = result.math.length;
    const runStart = runIndex;
    let rowHeight = 0;
    for (const [column, cell] of row.cells.entries()) {
      const runs: TextMarkdownBlock["runs"][number][] = [];
      while (runIndex < block.runs.length && block.runs[runIndex]!.end <= cell.contentStart)
        runIndex += 1;
      while (runIndex < block.runs.length && block.runs[runIndex]!.start < cell.contentEnd)
        runs.push(block.runs[runIndex++]!);
      const prepared = await layoutCell(
        { kind: "paragraph", ...cell, runs, spans: [], alignment: descriptor.alignments[column]! },
        {
          width: request.width / columns,
          top,
          x: (request.width * column) / columns,
          style: textBlockBaseStyle(request.style, rowIndex === 0),
        },
        ports,
        source,
      );
      rowHeight = Math.max(rowHeight, prepared.height);
      result.lines.push(...prepared.lines);
      result.math.push(...prepared.math);
      items += prepared.lines.reduce((count, line) => count + line.runs.length + 1, 0);
      items += prepared.math.reduce((count, math) => count + math.paths.length + 1, 0);
      if (items > MAX_TEXT_LAYOUT_ITEMS)
        throw new RangeError("Text table exceeds the supported item count.");
    }
    result.table.rowHeights.push(Math.max(0.001, canonical(rowHeight)));
    result.rows.push({
      top: canonical(top - request.top),
      lineStart,
      lineEnd: result.lines.length,
      mathStart,
      mathEnd: result.math.length,
      runStart,
      runEnd: runIndex,
    });
    top += Math.max(0.001, canonical(rowHeight));
  }
  result.table.height = canonical(result.table.rowHeights.reduce((sum, height) => sum + height, 0));
  return result;
}

async function layoutCell(
  block: TextMarkdownBlock & TextMarkdownTableCell,
  request: TextTableLayoutRequest & { readonly x: number },
  ports: TextLayoutPorts,
  source: string,
): Promise<{
  readonly height: number;
  readonly lines: TextLayoutLineV2[];
  readonly math: TextMathLayoutV2[];
}> {
  const padding = canonical(
    Math.min(request.style.fontSize * TEXT_TABLE_CELL_PADDING_EM, request.width / 4),
  );
  const width = Math.max(0.001, request.width - padding * 2);
  const glyph = textBlockGlyphStrut(block);
  const strutStyle = glyph?.style ?? request.style;
  const fontResourceId = ports.measure.resolveFontResourceId?.(strutStyle, {
    start: glyph?.start ?? block.contentStart,
    end: glyph?.start ?? block.contentStart,
  });
  const builder = new TextLineBuilder(block, width, request.top + padding, request.style, ports, {
    style: strutStyle,
    ...(fontResourceId === undefined ? {} : { fontResourceId }),
  });
  for await (const atom of textLayoutAtoms(block, ports, width, source)) {
    await builder.append(atom);
    if (builder.lines.length > MAX_TEXT_LAYOUT_ITEMS)
      throw new RangeError("Text table exceeds the supported item count.");
  }
  const bottom = builder.finish();
  for (const line of builder.lines) line.x = canonical(line.x + request.x + padding);
  for (const math of builder.math) math.x = canonical(math.x + request.x + padding);
  return {
    height: canonical(bottom - request.top + padding),
    lines: builder.lines,
    math: builder.math,
  };
}
