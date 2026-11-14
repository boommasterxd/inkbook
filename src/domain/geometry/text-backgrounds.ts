import type { ColorV1, TextElementV2, TextRangeStyleV2 } from "../schema/public";
import { MAX_TEXT_LAYOUT_ITEMS } from "../schema/text-validation-primitives";
import { textStyleAt, textStyleSegmentsSteps } from "../text/text-style-segments";
import { rectangleCutoutsSteps, type PaintRectangle } from "./rectangle-cutouts";
import { textBackgroundContoursSteps } from "./text-background-contours";
import {
  rectangleBackgroundPath,
  roundedBackgroundIntersection,
  textBackgroundRadius,
} from "./rounded-background-path";

export interface TextBackgroundPaint {
  readonly color: ColorV1;
  readonly opacity: number;
  readonly d: string;
}

export interface TextBackgroundGeometry {
  /** Undefined preserves the original whole-box paint when no override exists. */
  readonly basePath: string | undefined;
  readonly paints: readonly TextBackgroundPaint[];
}

export interface TextBackgroundRectangle extends PaintRectangle {
  readonly color: ColorV1 | null;
  readonly opacity: number;
}

/** Each layout item can split a normal rectangular base into at most four pieces. */
export const MAX_TEXT_BACKGROUND_RECTANGLES = MAX_TEXT_LAYOUT_ITEMS * 4 + 1;

/** Field-relative layout becomes one shared, alpha-correct Scene/SVG paint artifact. */
export function* textBackgroundGeometrySteps(
  element: TextElementV2,
  visit?: () => void,
  roundCorners = true,
  radius?: number,
  mergeBaseContours = true,
): Generator<void, TextBackgroundGeometry> {
  const rectangles: TextBackgroundRectangle[] = [];
  for (const line of element.layout.lines) {
    for (const run of line.runs) {
      visit?.();
      if (hasTextBackground(run.style) && run.width > 0 && line.height > 0)
        rectangles.push({
          x: element.x + line.x + run.x,
          y: element.y + line.y,
          width: run.width,
          height: line.height,
          ...effectiveTextBackground(element, run.style!),
        });
      yield;
    }
  }
  if (
    element.layout.math?.length &&
    element.ranges.some((range) => hasTextBackground(range.style))
  ) {
    const segments = yield* textStyleSegmentsSteps(element.ranges, element.source.length);
    for (const math of element.layout.math) {
      const style = textStyleAt(segments, math.start);
      if (hasTextBackground(style) && math.width > 0 && math.height > 0)
        rectangles.push({
          x: element.x + math.x,
          y: element.y + math.y,
          width: math.width,
          height: math.height,
          ...effectiveTextBackground(element, style),
        });
      visit?.();
      yield;
    }
  }
  if (!rectangles.length) return { basePath: undefined, paints: [] };
  return yield* partitionTextBackgroundSteps(
    { x: element.x, y: element.y, width: element.width, height: element.height },
    rectangles,
    visit,
    roundCorners,
    radius ?? textBackgroundRadius(element, element.style.fontSize),
    mergeBaseContours,
  );
}

/** Runtime source editing supplies its visible measured rectangles through this same paint rule. */
export function* partitionTextBackgroundSteps(
  box: PaintRectangle,
  rectangles: readonly TextBackgroundRectangle[],
  visit?: () => void,
  roundCorners = true,
  radius = 2,
  mergeBaseContours = true,
): Generator<void, { basePath: string; paints: readonly TextBackgroundPaint[] }> {
  const baseRectangles = yield* rectangleCutoutsSteps(box, rectangles, {
    maximumRectangles: MAX_TEXT_BACKGROUND_RECTANGLES,
    visit,
  });
  const basePath = mergeBaseContours
    ? yield* textBackgroundContoursSteps(box, baseRectangles, roundCorners ? radius : 0, visit)
    : yield* partitionedBasePath(box, baseRectangles, roundCorners, radius);
  const groups = new Map<string, TextBackgroundPaint>();
  for (const rectangle of rectangles) {
    const d = roundCorners
      ? roundedBackgroundIntersection(box, rectangle, radius)
      : rectangleBackgroundPath(rectangle);
    appendTextBackgroundPaint(groups, rectangle, d);
    yield;
  }
  return { basePath, paints: [...groups.values()] };
}

/** Retains the previous serialized partition for reading existing editable SVG output. */
function* partitionedBasePath(
  box: PaintRectangle,
  rectangles: readonly PaintRectangle[],
  roundCorners: boolean,
  radius: number,
): Generator<void, string> {
  let path = "";
  for (const rectangle of rectangles) {
    path += roundCorners
      ? roundedBackgroundIntersection(box, rectangle, radius)
      : rectangleBackgroundPath(rectangle);
    yield;
  }
  return path;
}

/** Equal paint shares one nonzero path so overlapping fragments apply its alpha once. */
export function appendTextBackgroundPaint(
  groups: Map<string, TextBackgroundPaint>,
  rectangle: TextBackgroundRectangle,
  d: string,
): void {
  if (d === "" || rectangle.color === null || rectangle.opacity <= 0) return;
  const key = `${rectangle.color.type === "theme-text" ? "theme-text" : rectangle.color.value}:${rectangle.opacity}`;
  groups.set(key, {
    color: rectangle.color,
    opacity: rectangle.opacity,
    d: (groups.get(key)?.d ?? "") + d,
  });
}

export function hasTextBackground(style: TextRangeStyleV2 | undefined): boolean {
  return style?.backgroundColor !== undefined || style?.backgroundOpacity !== undefined;
}

export function effectiveTextBackground(
  element: Pick<TextElementV2, "backgroundColor" | "backgroundOpacity">,
  style: TextRangeStyleV2,
): { color: ColorV1 | null; opacity: number } {
  return {
    color: style.backgroundColor === undefined ? element.backgroundColor : style.backgroundColor,
    opacity: style.backgroundOpacity ?? element.backgroundOpacity,
  };
}
