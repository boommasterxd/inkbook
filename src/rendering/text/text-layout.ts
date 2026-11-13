import {
  MAX_TEXT_LAYOUT_ITEMS,
  MAX_TEXT_SOURCE_LENGTH,
} from "../../domain/schema/text-validation-primitives";
import { canonicalizeGeometryNumber } from "../../domain/schema/canonical";
import { textContentWidth } from "../../domain/geometry/text-padding";
import { TEXT_LINE_HEIGHT, textTableFollowingGap } from "../../domain/text/text-layout-style";
import { blockTextStyle, textLayoutAtoms } from "./text-layout-atoms";
import { textBlockBaseStyle } from "../../domain/text/text-layout-style";
import { TextLineBuilder } from "./text-line-builder";
import { collectTextGlyphStruts } from "./text-layout-strut";
import { layoutTextTable } from "./text-table-layout";
import type { TextMarkdownBlock } from "../../domain/text/text-types";
import type {
  TextLayoutLineV2,
  TextMathLayoutV2,
  TextTableLayoutV2,
  TextStyleV2,
} from "../../domain/schema/public";
import {
  admitTextLayout,
  type TextLayoutPorts,
  type TextLayoutRequest,
  type TextLayoutResult,
  type TextLineStrut,
} from "./text-layout-types";

/** Position changes reuse this field-local artifact; only text, fonts, style or width require layout. */
export async function layoutTextMarkdown(
  request: TextLayoutRequest,
  ports: TextLayoutPorts,
): Promise<TextLayoutResult> {
  const padding = request.padding ?? 0;
  const width = textContentWidth(request.width, padding);
  if (request.document.source.length > MAX_TEXT_SOURCE_LENGTH)
    throw new Error("Text exceeds the supported source size.");
  const result: TextLayoutResult = {
    layout: {
      version: 1,
      lines: [],
      math: [],
      ...(request.padding === undefined ? {} : { padding }),
    },
    height: 0,
  };
  const struts = await collectTextGlyphStruts(request.document, ports);
  const baseFontResourceId = struts.first?.fontResourceId ?? request.baseFontResourceId;
  if (baseFontResourceId !== undefined) result.layout.baseFontResourceId = baseFontResourceId;
  let top = padding;
  let items = 0;
  let pathCharacters = 0;
  for (const block of request.document.blocks) {
    await admitTextLayout(ports);
    const style = blockTextStyle(
      block,
      textBlockBaseStyle(request.style, block.kind === "heading"),
    );
    const strut = struts.blocks.get(block) ?? {
      style,
      ...(baseFontResourceId === undefined ? {} : { fontResourceId: baseFontResourceId }),
    };
    const content = await layoutBlock(
      block,
      { width, top, style, strut },
      ports,
      request.document.source,
    );
    if (content.table) {
      content.table.x = canonicalizeGeometryNumber(content.table.x + padding);
      (result.layout.tables ??= []).push(content.table);
      items += content.table.rowHeights.length + content.table.columns + 1;
    }
    top = nextBlockTop(content, request.style.fontSize, block.end < request.document.source.length);
    if (result.layout.baseFontResourceId === undefined && content.strutFontResourceId !== undefined)
      result.layout.baseFontResourceId = content.strutFontResourceId;
    for (const line of content.lines) {
      items += line.runs.length + 1;
      line.x = canonicalizeGeometryNumber(line.x + padding);
    }
    for (const math of content.math) {
      math.x = canonicalizeGeometryNumber(math.x + padding);
      items += math.paths.length + 1;
      for (const path of math.paths) pathCharacters += path.d.length;
    }
    if (items > MAX_TEXT_LAYOUT_ITEMS || pathCharacters > 2_000_000)
      throw new Error("Text layout exceeds the supported geometry size.");
    result.layout.lines.push(...content.lines);
    result.layout.math!.push(...content.math);
  }
  await admitTextLayout(ports);
  return {
    layout: result.layout,
    height: canonicalizeGeometryNumber(
      (top > padding ? top - padding : request.style.fontSize * TEXT_LINE_HEIGHT) + padding * 2,
    ),
  };
}

interface PreparedTextBlock {
  readonly lines: TextLayoutLineV2[];
  readonly math: TextMathLayoutV2[];
  readonly table?: TextTableLayoutV2;
  readonly top: number;
  readonly strutFontResourceId?: string;
}

function nextBlockTop(content: PreparedTextBlock, fontSize: number, hasFollowing: boolean): number {
  return content.top + (content.table && hasFollowing ? textTableFollowingGap(fontSize) : 0);
}

async function layoutBlock(
  block: TextMarkdownBlock,
  request: {
    readonly width: number;
    readonly top: number;
    readonly style: TextStyleV2;
    readonly strut: TextLineStrut;
  },
  ports: TextLayoutPorts,
  source: string,
): Promise<PreparedTextBlock> {
  if (block.kind === "table") {
    const result = await layoutTextTable(block, request, ports, source);
    ports.onTablePrepared?.(block, result);
    return { ...result, top: result.table.y + result.table.height };
  }
  const builder = new TextLineBuilder(
    block,
    request.width,
    request.top,
    request.style,
    ports,
    request.strut,
  );
  for await (const atom of textLayoutAtoms(block, ports, request.width, source)) {
    await builder.append(atom);
    if (builder.lines.length > MAX_TEXT_LAYOUT_ITEMS)
      throw new Error("Text layout exceeds the supported item count.");
  }
  return {
    lines: builder.lines,
    math: builder.math,
    top: builder.finish(),
    ...(builder.strutFontResourceId === undefined
      ? {}
      : { strutFontResourceId: builder.strutFontResourceId }),
  };
}
