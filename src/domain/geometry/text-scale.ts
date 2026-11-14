import type { TextElementV2, TextLayoutV2, TextRangeStyleV2 } from "../schema/types";
import { canonicalizeGeometryNumber } from "../schema/canonical";
import { scaleMathPathDataSteps } from "./text-math-path";

export function scaledTextContent(
  element: TextElementV2,
  factor: number,
  outerWidth?: number,
): TextElementV2 {
  const steps = scaledTextContentSteps(element, factor, "scale", outerWidth);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Yields bounded operations under the owning scheduler. Reflow drafts retain only
 * source styles, font binding and proportional padding for the native layout producer.
 */
export function* scaledTextContentSteps(
  element: TextElementV2,
  factor: number,
  layoutMode: "scale" | "reflow" = "scale",
  outerWidth = canonicalizeGeometryNumber(element.width * factor),
): Generator<void, TextElementV2> {
  if (!Number.isFinite(factor) || factor <= 0)
    throw new RangeError("Text scale must be positive and finite.");
  const number = (value: number) => canonicalizeGeometryNumber(value * factor);
  const style = (value: TextRangeStyleV2): TextRangeStyleV2 =>
    value.fontSize === undefined ? { ...value } : { ...value, fontSize: number(value.fontSize) };
  const layout: TextLayoutV2 = {
    version: 1,
    lines: [],
    ...(element.layout.padding === undefined
      ? {}
      : {
          padding: Math.min(number(element.layout.padding), Math.floor(outerWidth * 250) / 1000),
        }),
    ...(element.layout.baseFontResourceId === undefined
      ? {}
      : { baseFontResourceId: element.layout.baseFontResourceId }),
  };
  for (const line of layoutMode === "scale" ? element.layout.lines : []) {
    const runs: typeof line.runs = [];
    for (const run of line.runs) {
      runs.push({
        ...run,
        x: number(run.x),
        width: number(run.width),
        ...(run.style === undefined ? {} : { style: style(run.style) }),
      });
      yield;
    }
    layout.lines.push({
      x: number(line.x),
      y: number(line.y),
      width: number(line.width),
      height: number(line.height),
      baseline: number(line.baseline),
      runs,
    });
    yield;
  }
  if (layoutMode === "scale" && element.layout.math !== undefined) {
    layout.math = [];
    for (const math of element.layout.math) {
      const paths: typeof math.paths = [];
      for (const path of math.paths)
        paths.push({ ...path, d: yield* scaleMathPathDataSteps(path.d, factor) });
      layout.math.push({
        ...math,
        x: number(math.x),
        y: number(math.y),
        width: number(math.width),
        height: number(math.height),
        paths,
      });
      yield;
    }
  }
  if (layoutMode === "scale" && element.layout.tables !== undefined) {
    layout.tables = [];
    for (const table of element.layout.tables) {
      const rowHeights: number[] = [];
      for (const height of table.rowHeights) {
        rowHeights.push(number(height));
        yield;
      }
      layout.tables.push({
        ...table,
        x: number(table.x),
        y: number(table.y),
        width: number(table.width),
        height: canonicalizeGeometryNumber(rowHeights.reduce((sum, height) => sum + height, 0)),
        borderWidth: number(table.borderWidth),
        rowHeights,
      });
      yield;
    }
  }
  const ranges: typeof element.ranges = [];
  for (const range of element.ranges) {
    ranges.push({ ...range, style: style(range.style) });
    yield;
  }
  return {
    ...element,
    style: { ...element.style, fontSize: number(element.style.fontSize) },
    ranges,
    layout,
  };
}
