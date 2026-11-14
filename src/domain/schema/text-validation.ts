import { canonicalizeGeometryNumber } from "./canonical";
import { MAX_DOCUMENT_TEXT_BYTES } from "./constants";
import type { TextElementV2 } from "./types";
import { textElementPayloadBytes } from "./text-payload-size";
import { assertColor } from "./style-validation";
import {
  assertExactKeys,
  assertGeometryNumber,
  assertIntegerRange,
  assertOneOf,
  assertRecord,
  assertUnitInterval,
  fail,
  type UnknownRecord,
  type ValidationContext,
} from "./validation-internals";
import { assertTextLayoutSteps } from "./text-layout-validation";
import {
  assertTextStyle,
  assertTextString,
  assertTextArray,
  assertTextSourceRange,
  MAX_TEXT_SOURCE_LENGTH,
  MAX_TEXT_STYLE_RANGES,
} from "./text-validation-primitives";

export function* assertTextElementSteps(
  value: UnknownRecord,
  path: string,
  context: ValidationContext,
): Generator<void, void> {
  assertExactKeys(
    value,
    [
      "kind",
      "id",
      "createdAt",
      "rotation",
      "pivot",
      "x",
      "y",
      "width",
      "height",
      "source",
      "style",
      "ranges",
      "paragraphs",
      "backgroundColor",
      "backgroundOpacity",
      "layout",
    ],
    path,
  );
  for (const key of ["x", "y", "width", "height"] as const) {
    assertGeometryNumber(value[key], `${path}.${key}`, context.limits.absoluteCoordinate);
  }
  if ((value.width as number) < 0 || (value.height as number) < 0)
    fail("invalid-range", path, "Text dimensions must be nonnegative.");
  const pivot = value.pivot as { x: number; y: number };
  if (
    pivot.x !== canonicalizeGeometryNumber((value.x as number) + (value.width as number) / 2) ||
    pivot.y !== canonicalizeGeometryNumber((value.y as number) + (value.height as number) / 2)
  ) {
    fail("invalid-range", `${path}.pivot`, "Text pivot must equal its bounds center.");
  }
  assertTextString(value.source, MAX_TEXT_SOURCE_LENGTH, `${path}.source`);
  assertTextStyle(value.style, `${path}.style`);
  if (value.backgroundColor !== null) assertColor(value.backgroundColor, `${path}.backgroundColor`);
  assertUnitInterval(value.backgroundOpacity, `${path}.backgroundOpacity`);
  yield* assertRanges(value.ranges, value.source.length, `${path}.ranges`);
  yield* assertParagraphs(value.paragraphs, value.source, `${path}.paragraphs`);
  const layoutBytes = yield* assertTextLayoutSteps(
    value.layout,
    value.source.length,
    path,
    context,
  );
  const padding = (value.layout as { padding?: number }).padding ?? 0;
  if (padding > (value.width as number) / 4 || padding * 2 > (value.height as number))
    fail(
      "invalid-range",
      `${path}.layout.padding`,
      "Text padding must fit inside the outer field.",
    );
  context.textPayloadBytes =
    (context.textPayloadBytes ?? 0) +
    textElementPayloadBytes(value as unknown as TextElementV2, layoutBytes);
  if (context.textPayloadBytes > MAX_DOCUMENT_TEXT_BYTES)
    fail("invalid-range", path, "Aggregate text payload exceeds the document memory limit.");
}

function* assertRanges(value: unknown, length: number, path: string): Generator<void, void> {
  assertTextArray(value, MAX_TEXT_STYLE_RANGES, path);
  for (let index = 0; index < value.length; index += 1) {
    const range = value[index];
    const location = `${path}[${index}]`;
    assertRecord(range, location);
    assertExactKeys(range, ["start", "end", "style"], location);
    assertTextSourceRange(range, length, location);
    if (range.start === range.end)
      fail("invalid-range", location, "Formatting ranges must be nonempty.");
    assertTextStyle(range.style, `${location}.style`, true);
    yield;
  }
}

function* assertParagraphs(value: unknown, source: string, path: string): Generator<void, void> {
  assertTextArray(value, MAX_TEXT_STYLE_RANGES, path);
  let previous = -1;
  for (let index = 0; index < value.length; index += 1) {
    const paragraph: unknown = value[index];
    const location = `${path}[${index}]`;
    assertRecord(paragraph, location);
    assertExactKeys(paragraph, ["start", "alignment"], location);
    assertIntegerRange(paragraph.start, 0, source.length, `${location}.start`);
    if (
      paragraph.start <= previous ||
      (paragraph.start > 0 && source[paragraph.start - 1] !== "\n")
    )
      fail("invalid-range", location, "Paragraph offsets must be ordered paragraph starts.");
    assertOneOf(
      paragraph.alignment,
      ["left", "center", "right", "justify"] as const,
      `${location}.alignment`,
    );
    previous = paragraph.start;
    yield;
  }
}
