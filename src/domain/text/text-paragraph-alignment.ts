import type { TextParagraphStyleV2 } from "../schema/public";
import type { TextMarkdownBlock } from "./text-types";

/** Explicit source lines own alignment; visual wraps reuse their source line's value. */
export function textBlockAlignmentAt(
  block: Pick<TextMarkdownBlock, "alignment" | "sourceAlignments">,
  sourcePosition: number,
): TextParagraphStyleV2["alignment"] {
  const records = block.sourceAlignments ?? [];
  let lower = 0;
  let upper = records.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (records[middle]!.start <= sourcePosition) lower = middle + 1;
    else upper = middle;
  }
  return records[lower - 1]?.alignment ?? block.alignment;
}
