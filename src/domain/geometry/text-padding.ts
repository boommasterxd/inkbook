import type { TextElementV2 } from "../schema/types";
import { canonicalizeGeometryNumber as canonical } from "../schema/canonical";

/** Persisted field-local padding is authoritative; missing padding preserves legacy geometry. */
export function textPaddingForWidth(fontSize: number, outerWidth: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0 || !Number.isFinite(outerWidth) || outerWidth < 0)
    throw new RangeError("Text padding requires a positive font size and nonnegative width.");
  return Math.min(canonical(Math.max(fontSize, 28)), Math.floor(outerWidth * 250) / 1000);
}

export function textContentWidth(outerWidth: number, padding = 0): number {
  if (
    !Number.isFinite(outerWidth) ||
    outerWidth < 0 ||
    !Number.isFinite(padding) ||
    padding < 0 ||
    padding > outerWidth / 4
  )
    throw new RangeError("Text padding must fit inside a finite nonnegative field width.");
  return canonical(outerWidth - padding * 2);
}

/** Source edits retain stored/scaled insets; explicit font-size edits establish a new inset. */
export function textPaddingForReflow(element: TextElementV2, previousFontSize?: number): number {
  if (previousFontSize === element.style.fontSize)
    return Math.min(element.layout.padding ?? 0, Math.floor(element.width * 250) / 1000);
  return textPaddingForWidth(element.style.fontSize, element.width);
}

/** Expand only the outer inset while retaining wrapping and font resource bindings. */
export function* expandLegacyTextPaddingSteps(
  element: TextElementV2,
): Generator<void, TextElementV2> {
  const previousPadding = element.layout.padding ?? 0;
  const innerWidth = textContentWidth(element.width, previousPadding);
  const padding = textPaddingForWidth(element.style.fontSize, innerWidth * 2);
  if (element.layout.padding !== undefined && previousPadding >= padding) return element;
  const expansion = canonical(padding - previousPadding);
  const layout: TextElementV2["layout"] = { ...element.layout, padding, lines: [] };
  for (const line of element.layout.lines) {
    layout.lines.push({
      ...line,
      x: canonical(line.x + expansion),
      y: canonical(line.y + expansion),
    });
    yield;
  }
  if (element.layout.math !== undefined) {
    layout.math = [];
    for (const math of element.layout.math) {
      layout.math.push({
        ...math,
        x: canonical(math.x + expansion),
        y: canonical(math.y + expansion),
      });
      yield;
    }
  }
  if (element.layout.tables !== undefined) {
    layout.tables = [];
    for (const table of element.layout.tables) {
      layout.tables.push({
        ...table,
        x: canonical(table.x + expansion),
        y: canonical(table.y + expansion),
      });
      yield;
    }
  }
  const x = canonical(element.x - expansion);
  const y = canonical(element.y - expansion);
  const width = canonical(element.width + expansion * 2);
  const height = canonical(element.height + expansion * 2);
  return {
    ...element,
    x,
    y,
    width,
    height,
    pivot: { x: canonical(x + width / 2), y: canonical(y + height / 2) },
    layout,
  };
}
