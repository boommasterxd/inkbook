import type { TextMarkdownBlock, TextMarkdownDocument } from "../../domain/text/text-types";
import { blockTextStyle } from "./text-layout-atoms";
import { admitTextLayout, type TextLayoutPorts, type TextLineStrut } from "./text-layout-types";

/** Whitespace and outlined math cannot make an unused regular font a layout dependency. */
export function textBlockGlyphStrut(
  block: TextMarkdownBlock,
): (TextLineStrut & { readonly start: number }) | undefined {
  for (const run of block.runs) {
    if (run.kind !== "text") continue;
    const offset = run.text.search(/\S/u);
    if (offset === -1) continue;
    const start =
      run.contentEnd - run.contentStart === run.text.length
        ? run.contentStart + offset
        : run.contentStart;
    return { style: blockTextStyle(block, run.style, run.code), start };
  }
  return undefined;
}

export async function collectTextGlyphStruts(
  document: TextMarkdownDocument,
  ports: TextLayoutPorts,
) {
  const blocks = new Map<TextMarkdownBlock, TextLineStrut>();
  let first: TextLineStrut | undefined;
  for (const block of document.blocks) {
    await admitTextLayout(ports);
    const glyph = textBlockGlyphStrut(block);
    if (!glyph) continue;
    const fontResourceId = ports.measure.resolveFontResourceId?.(glyph.style, {
      start: glyph.start,
      end: glyph.start,
    });
    const strut = {
      style: glyph.style,
      ...(fontResourceId === undefined ? {} : { fontResourceId }),
    };
    blocks.set(block, strut);
    first ??= strut;
  }
  return { blocks, first };
}
