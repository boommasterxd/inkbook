import type { ColorV1, TextElementV2, TextRangeStyleV2 } from "../schema/public";
import { MAX_TEXT_LAYOUT_ITEMS } from "../schema/text-validation-primitives";
import { textStyleAt, textStyleSegmentsSteps } from "../text/text-style-segments";
import { rectangleCutoutsSteps, type PaintRectangle } from "./rectangle-cutouts";
import { textBackgroundRadius } from "./rounded-background-path";
import { effectiveTextBackground, hasTextBackground } from "./text-backgrounds";
import { textTableGridRectangles } from "./text-table-grid-rectangles";

export interface TextPaintRegion extends Readonly<PaintRectangle> {
  readonly roundedClip?: {
    readonly width: number;
    readonly height: number;
    readonly radius: number;
  };
}

/** Ink, overrides and the base's four-way cutouts share the existing layout capacity. */
export const MAX_TEXT_PAINT_REGIONS = MAX_TEXT_LAYOUT_ITEMS * 6 + 1;

/** Uses retained typographic advances, never inferred character positions or font work. */
export function* textPaintRegionSteps(
  element: TextElementV2,
  visit?: () => void,
): Generator<void, TextPaintRegion[]> {
  const regions = new PaintRegions(element);
  yield* collectLines(element, regions, visit);
  yield* collectMath(element, regions, visit);
  if (visiblePaint(element.style.color, element.style.opacity)) {
    for (const table of element.layout.tables ?? []) {
      for (const rectangle of textTableGridRectangles(table)) {
        regions.append(rectangle);
        visit?.();
        yield;
      }
    }
  }
  yield* regions.base(visit);
  return regions.items;
}

function* collectLines(
  element: TextElementV2,
  regions: PaintRegions,
  visit: (() => void) | undefined,
): Generator<void> {
  for (const line of element.layout.lines) {
    let first = Infinity;
    let last = -Infinity;
    let visibleText = false;
    for (const run of line.runs) {
      const rectangle = {
        x: line.x + run.x,
        y: line.y,
        width: run.width,
        height: line.height,
      };
      const style = run.style;
      if (
        run.text.length > 0 &&
        visiblePaint(style?.color ?? element.style.color, style?.opacity ?? element.style.opacity)
      ) {
        first = Math.min(first, rectangle.x);
        last = Math.max(last, rectangle.x + rectangle.width);
        visibleText ||=
          run.text.trim().length > 0 ||
          (style?.underline ?? element.style.underline) ||
          (style?.strikethrough ?? element.style.strikethrough);
      }
      regions.background(rectangle, style);
      visit?.();
      yield;
    }
    if (visibleText)
      regions.append({ x: first, y: line.y, width: last - first, height: line.height });
    visit?.();
    yield;
  }
}

function* collectMath(
  element: TextElementV2,
  regions: PaintRegions,
  visit: (() => void) | undefined,
): Generator<void> {
  if (element.layout.math?.length) {
    const segments = yield* textStyleSegmentsSteps(element.ranges, element.source.length);
    for (const math of element.layout.math) {
      const rectangle = { x: math.x, y: math.y, width: math.width, height: math.height };
      const style = textStyleAt(segments, math.start);
      if (
        (yield* hasMathPaint(math.paths, visit)) &&
        visiblePaint(style.color ?? element.style.color, style.opacity ?? element.style.opacity)
      )
        regions.append(rectangle);
      regions.background(rectangle, style);
      visit?.();
      yield;
    }
  }
}

function* hasMathPaint(
  paths: readonly { readonly d: string }[],
  visit: (() => void) | undefined,
): Generator<void, boolean> {
  for (const path of paths) {
    visit?.();
    yield;
    if (path.d.length > 0) return true;
  }
  return false;
}

function visiblePaint(color: ColorV1 | null, opacity: number): boolean {
  return (
    opacity > 0 && color !== null && (color.type === "theme-text" || color.value.slice(-2) !== "00")
  );
}

class PaintRegions {
  public readonly items: TextPaintRegion[] = [];
  readonly #cuts: PaintRectangle[] = [];
  readonly #box: PaintRectangle;
  readonly #clip: NonNullable<TextPaintRegion["roundedClip"]>;

  public constructor(private readonly element: TextElementV2) {
    this.#box = { x: 0, y: 0, width: element.width, height: element.height };
    this.#clip = {
      width: element.width,
      height: element.height,
      radius: textBackgroundRadius(this.#box, element.style.fontSize),
    };
  }

  public append(rectangle: PaintRectangle, background = false): void {
    if (rectangle.width <= 0 || rectangle.height <= 0) return;
    if (this.items.length >= MAX_TEXT_PAINT_REGIONS)
      throw new RangeError("Text paint geometry exceeds its layout-derived capacity.");
    if (!background) {
      this.items.push(rectangle);
      return;
    }
    const x = Math.max(0, rectangle.x);
    const y = Math.max(0, rectangle.y);
    const right = Math.min(this.#box.width, rectangle.x + rectangle.width);
    const bottom = Math.min(this.#box.height, rectangle.y + rectangle.height);
    if (right > x && bottom > y)
      this.items.push({
        x,
        y,
        width: right - x,
        height: bottom - y,
        roundedClip: this.#clip,
      });
  }

  public background(rectangle: PaintRectangle, style: TextRangeStyleV2 | undefined): void {
    if (!hasTextBackground(style) || rectangle.width <= 0 || rectangle.height <= 0) return;
    this.#cuts.push(rectangle);
    const paint = effectiveTextBackground(this.element, style!);
    if (visiblePaint(paint.color, paint.opacity)) this.append(rectangle, true);
  }

  public *base(visit: (() => void) | undefined): Generator<void> {
    if (!visiblePaint(this.element.backgroundColor, this.element.backgroundOpacity)) return;
    const rectangles = yield* rectangleCutoutsSteps(this.#box, this.#cuts, {
      maximumRectangles: MAX_TEXT_LAYOUT_ITEMS * 4 + 1,
      ...(visit === undefined ? {} : { visit }),
    });
    for (const rectangle of rectangles) {
      this.append(rectangle, true);
      visit?.();
      yield;
    }
  }
}
