import type { TextSourceRange } from "../../../domain/text/text-types";
import type { TextMathWidgetPorts } from "./text-field-editor-types";

/** Map a local editor range to its authoritative font-resource binding coordinates. */
export function textFontSourceRange(
  range: TextSourceRange,
  originalPosition: (position: number, association: -1 | 1) => number,
  offset = 0,
): TextSourceRange {
  return {
    start: originalPosition(offset + range.start, 1),
    end: originalPosition(offset + range.end, range.start === range.end ? 1 : -1),
  };
}

/** A semantic source run may retain several independently bound font faces. */
export function* textFontFragments(
  start: number,
  end: number,
  ports: TextMathWidgetPorts,
): Generator<TextSourceRange> {
  let position = start;
  for (const boundary of ports.fontResourceBoundaries?.(start, end) ?? []) {
    if (boundary <= start || boundary >= end) continue;
    if (!Number.isInteger(boundary) || boundary <= position)
      throw new RangeError("Invalid font binding boundary.");
    yield { start: position, end: boundary };
    position = boundary;
  }
  yield { start: position, end };
}
