import type { TextElementV2 } from "../../domain/schema/public";
import { formatTextMarkdownStyle } from "../../domain/text/text-mark-formatting";
import {
  applyTextEditsSteps,
  type TextSourceRangeMapper,
} from "../../domain/text/text-source-edits";

export function changeWholeTextMark(
  element: TextElementV2,
  mark: "bold" | "italic" | "strikethrough",
  value: boolean,
): TextElementV2 {
  const formatted = formatTextMarkdownStyle(
    element,
    { start: 0, end: element.source.length },
    { mark, desired: value, base: value ? element.style : { ...element.style, [mark]: false } },
  );
  if (
    !formatted.changes.length &&
    element.style[mark] === value &&
    equalRanges(element.ranges, formatted.stateBeforeChanges.ranges)
  )
    return element;
  let mapRange: TextSourceRangeMapper | undefined;
  const steps = applyTextEditsSteps(formatted.stateBeforeChanges, formatted.changes, (mapper) => {
    mapRange = mapper;
  });
  let step = steps.next();
  while (!step.done) step = steps.next();
  if (mapRange === undefined) throw new Error("Text source edits did not provide a range mapper.");
  return {
    ...element,
    style: { ...element.style, [mark]: value },
    source: step.value.source,
    ranges: [...step.value.ranges],
    paragraphs: [...step.value.paragraphs],
    layout: formatted.changes.length ? mapLayoutRanges(element.layout, mapRange) : element.layout,
  };
}

function equalRanges(
  left: TextElementV2["ranges"],
  right: readonly TextElementV2["ranges"][number][],
): boolean {
  return (
    left.length === right.length &&
    left.every((range, index) => {
      const other = right[index]!;
      const keys = Object.keys(range.style) as (keyof typeof range.style)[];
      return (
        range.start === other.start &&
        range.end === other.end &&
        keys.length === Object.keys(other.style).length &&
        keys.every((key) => range.style[key] === other.style[key])
      );
    })
  );
}

/** Keep source coordinates valid until the existing font/layout preparation replaces geometry. */
function mapLayoutRanges(
  layout: TextElementV2["layout"],
  mapRange: TextSourceRangeMapper,
): TextElementV2["layout"] {
  return {
    ...layout,
    lines: layout.lines.map((line) => ({
      ...line,
      runs: line.runs.map((run) => ({ ...run, ...mapRange(run) })),
    })),
    ...(layout.math === undefined
      ? {}
      : { math: layout.math.map((entry) => ({ ...entry, ...mapRange(entry) })) }),
  };
}
