import { canonicalizeGeometryNumber } from "../schema/canonical";
import type { TextStyleV2 } from "../schema/types";

/** Shared metrics for portable layout and the native source editor. */
export const TEXT_LINE_HEIGHT = 1.3;
export const TEXT_TAB_SIZE = 4;
export const TEXT_TABLE_CELL_PADDING_EM = 0.25;
export const TEXT_TABLE_BORDER_EM = 0.05;
/** Reserves a rail and its touch target before a following text block at native scale. */
export function textTableFollowingGap(fontSize: number): number {
  return canonicalizeGeometryNumber(Math.max(fontSize, 28));
}
export const TEXT_HEADING_SCALES = [2, 1.6, 1.35, 1.15, 1.05, 1] as const;
export const TEXT_LIST_INDENT_EM = 1.5;
export const TEXT_LIST_MARKER_GAP_EM = 0.35;
export const TEXT_CODE_FONT_FAMILY = "jetbrains-mono";

/** Heading emphasis is an inherited default, before explicit source-range overrides. */
export function textBlockBaseStyle(style: TextStyleV2, heading: boolean): TextStyleV2 {
  return heading ? { ...style, bold: true } : style;
}

export function textBlockStyle(
  style: TextStyleV2,
  headingLevel?: number,
  code = false,
): TextStyleV2 {
  return {
    ...style,
    fontFamily: code ? TEXT_CODE_FONT_FAMILY : style.fontFamily,
    ...(headingLevel === undefined
      ? {}
      : {
          fontSize: canonicalizeGeometryNumber(
            Math.min(4096, style.fontSize * (TEXT_HEADING_SCALES[headingLevel - 1] ?? 1)),
          ),
        }),
  };
}
