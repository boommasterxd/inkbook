import { assertColor } from "./style-validation";
import { fontCssFamily } from "../text/font-family";
import {
  assertBoolean,
  assertExactKeys,
  assertGeometryNumber,
  assertIntegerRange,
  assertRecord,
  assertUnitInterval,
  fail,
  type UnknownRecord,
} from "./validation-internals";

export const MAX_TEXT_SOURCE_LENGTH = 100_000;
export const MAX_TEXT_STYLE_RANGES = 4096;
export const MAX_TEXT_LAYOUT_ITEMS = 16_384;

const STYLE_KEYS = [
  "fontFamily",
  "fontSize",
  "color",
  "opacity",
  "bold",
  "italic",
  "underline",
  "strikethrough",
] as const;
const RANGE_STYLE_KEYS = [...STYLE_KEYS, "backgroundColor", "backgroundOpacity"];

export function assertTextStyle(value: unknown, path: string, partial = false): void {
  assertRecord(value, path);
  const keys = partial ? Object.keys(value) : STYLE_KEYS;
  const supported: readonly string[] = partial ? RANGE_STYLE_KEYS : STYLE_KEYS;
  if (keys.some((key) => !supported.includes(key))) {
    fail("unknown-property", path, "Unsupported text style property.");
  }
  assertExactKeys(value, keys, path);
  if (!partial || value.fontFamily !== undefined)
    assertTextFontFamily(value.fontFamily, `${path}.fontFamily`);
  if (!partial || value.fontSize !== undefined) {
    assertGeometryNumber(value.fontSize, `${path}.fontSize`, 4096);
    if (value.fontSize <= 0)
      fail("invalid-range", `${path}.fontSize`, "Font size must be positive.");
  }
  if (!partial || value.color !== undefined) assertColor(value.color, `${path}.color`);
  if (!partial || value.opacity !== undefined) assertUnitInterval(value.opacity, `${path}.opacity`);
  for (const key of ["bold", "italic", "underline", "strikethrough"] as const) {
    if (!partial || value[key] !== undefined) assertBoolean(value[key], `${path}.${key}`);
  }
  if (partial) assertRangeBackground(value, path);
}

function assertRangeBackground(value: UnknownRecord, path: string): void {
  if (value.backgroundColor !== undefined && value.backgroundColor !== null)
    assertColor(value.backgroundColor, `${path}.backgroundColor`);
  if (value.backgroundOpacity !== undefined)
    assertUnitInterval(value.backgroundOpacity, `${path}.backgroundOpacity`);
}

export function assertTextFontFamily(value: unknown, path: string): asserts value is string {
  assertTextString(value, 96, path, false);
  try {
    fontCssFamily(value);
  } catch {
    fail("invalid-range", path, "Font families must use portable ASCII identifiers.");
  }
}

export function assertTextString(
  value: unknown,
  maximum: number,
  path: string,
  empty = true,
): asserts value is string {
  if (typeof value !== "string") fail("invalid-type", path, "Expected text.");
  if (value.length > maximum || (!empty && value.length === 0) || value.includes("\u0000")) {
    fail("invalid-range", path, "Text exceeds the supported size or contains a null character.");
  }
}

export function assertTextArray(
  value: unknown,
  maximum: number,
  path: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) fail("invalid-type", path, "Expected an array.");
  if (value.length > maximum) fail("invalid-range", path, "Text item count exceeds the limit.");
}

export function assertTextSourceRange(value: UnknownRecord, length: number, path: string): void {
  assertIntegerRange(value.start, 0, length, `${path}.start`);
  assertIntegerRange(value.end, value.start, length, `${path}.end`);
}
