import { assertMathPathDataSteps } from "../geometry/text-math-path";
import { canonicalizeGeometryNumber } from "./canonical";
import { retainValidatedTextLayoutBytes, textBackgroundPayloadBytes } from "./text-payload-size";
import {
  assertTextArray,
  assertTextSourceRange,
  assertTextString,
  assertTextStyle,
  MAX_TEXT_LAYOUT_ITEMS,
  MAX_TEXT_SOURCE_LENGTH,
} from "./text-validation-primitives";
import {
  assertBoolean,
  assertExactKeys,
  assertGeometryNumber,
  assertIntegerRange,
  assertLiteral,
  assertOneOf,
  assertRecord,
  fail,
  type UnknownRecord,
  type ValidationContext,
} from "./validation-internals";

export function* assertTextLayoutSteps(
  value: unknown,
  sourceLength: number,
  elementPath: string,
  context: ValidationContext,
): Generator<void, number> {
  const path = `${elementPath}.layout`;
  assertRecord(value, path);
  assertExactKeys(
    value,
    [
      "version",
      "lines",
      ...(value.padding === undefined ? [] : ["padding"]),
      ...(value.math === undefined ? [] : ["math"]),
      ...(value.tables === undefined ? [] : ["tables"]),
      ...(value.baseFontResourceId === undefined ? [] : ["baseFontResourceId"]),
    ],
    path,
  );
  assertLiteral(value.version, 1, `${path}.version`);
  if (value.padding !== undefined) {
    assertGeometryNumber(value.padding, `${path}.padding`, context.limits.absoluteCoordinate);
    if (value.padding < 0)
      fail("invalid-range", `${path}.padding`, "Text padding must be nonnegative.");
  }
  assertFontResourceReference(value.baseFontResourceId, `${path}.baseFontResourceId`);
  assertTextArray(value.lines, MAX_TEXT_LAYOUT_ITEMS, `${path}.lines`);
  let itemCount = 0;
  let renderedLength = 0;
  let bytes = 0;
  for (let index = 0; index < value.lines.length; index += 1) {
    const line = value.lines[index];
    bytes += 64;
    const location = `${path}.lines[${index}]`;
    assertRecord(line, location);
    assertExactKeys(line, ["x", "y", "width", "height", "baseline", "runs"], location);
    assertBox(line, location, context);
    assertGeometryNumber(line.baseline, `${location}.baseline`, context.limits.absoluteCoordinate);
    if (line.baseline < 0 || line.baseline > (line.height as number))
      fail("invalid-range", location, "Text baseline must lie inside its line.");
    assertTextArray(line.runs, MAX_TEXT_LAYOUT_ITEMS, `${location}.runs`);
    itemCount += line.runs.length + 1;
    if (itemCount > MAX_TEXT_LAYOUT_ITEMS)
      fail("invalid-range", path, "Text layout exceeds the item limit.");
    for (let runIndex = 0; runIndex < line.runs.length; runIndex += 1) {
      const run = assertRun(
        line.runs[runIndex],
        sourceLength,
        `${location}.runs[${runIndex}]`,
        context,
      );
      renderedLength += run.textLength;
      bytes += run.bytes;
      yield;
    }
    yield;
    if (renderedLength > MAX_TEXT_SOURCE_LENGTH * 2)
      fail("invalid-range", path, "Rendered text exceeds the size limit.");
  }
  if (value.tables !== undefined) {
    const tables = yield* assertTables(
      value.tables,
      sourceLength,
      `${path}.tables`,
      context,
      itemCount,
    );
    bytes += tables.bytes;
    itemCount = tables.items;
  }
  if (value.math !== undefined)
    bytes += yield* assertMath(value.math, sourceLength, `${path}.math`, context, itemCount);
  retainValidatedTextLayoutBytes(value, bytes);
  return bytes;
}

function* assertTables(
  value: unknown,
  sourceLength: number,
  path: string,
  context: ValidationContext,
  initialItems: number,
): Generator<void, { bytes: number; items: number }> {
  assertTextArray(value, MAX_TEXT_LAYOUT_ITEMS, path);
  let items = initialItems;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const table = value[index];
    const location = `${path}[${index}]`;
    assertRecord(table, location);
    assertExactKeys(
      table,
      ["start", "end", "x", "y", "width", "height", "columns", "rowHeights", "borderWidth"],
      location,
    );
    assertBox(table, location, context);
    assertTextSourceRange(table, sourceLength, location);
    assertIntegerRange(table.columns, 1, MAX_TEXT_LAYOUT_ITEMS, `${location}.columns`);
    assertTextArray(table.rowHeights, MAX_TEXT_LAYOUT_ITEMS, `${location}.rowHeights`);
    items += table.rowHeights.length + table.columns + 1;
    if (items > MAX_TEXT_LAYOUT_ITEMS)
      fail("invalid-range", path, "Text layout exceeds the item limit.");
    assertGeometryNumber(
      table.borderWidth,
      `${location}.borderWidth`,
      context.limits.absoluteCoordinate,
    );
    if (
      table.start === table.end ||
      table.rowHeights.length === 0 ||
      table.borderWidth < 0 ||
      table.borderWidth > (table.width as number) / table.columns
    )
      fail(
        "invalid-range",
        location,
        "Table grids require positive source, rows and columns with nonnegative fitting borders.",
      );
    let height = 0;
    for (let row = 0; row < table.rowHeights.length; row += 1) {
      const rowHeight = table.rowHeights[row];
      assertGeometryNumber(
        rowHeight,
        `${location}.rowHeights[${row}]`,
        context.limits.absoluteCoordinate,
      );
      if (rowHeight <= 0 || rowHeight < table.borderWidth)
        fail("invalid-range", location, "Table rows must be positive and contain their border.");
      height += rowHeight;
      yield;
    }
    if (canonicalizeGeometryNumber(height) !== table.height)
      fail("invalid-range", location, "Table row heights must equal the frame height.");
    bytes += 128 + table.rowHeights.length * 8;
    yield;
  }
  return { bytes, items };
}

function assertRun(
  value: unknown,
  sourceLength: number,
  path: string,
  context: ValidationContext,
): { textLength: number; bytes: number } {
  assertRecord(value, path);
  assertExactKeys(
    value,
    [
      "text",
      "start",
      "end",
      "x",
      "width",
      ...(value.style === undefined ? [] : ["style"]),
      ...(value.fontResourceId === undefined ? [] : ["fontResourceId"]),
    ],
    path,
  );
  assertTextString(value.text, MAX_TEXT_SOURCE_LENGTH, `${path}.text`);
  assertFontResourceReference(value.fontResourceId, `${path}.fontResourceId`);
  assertTextSourceRange(value, sourceLength, path);
  assertGeometryNumber(value.x, `${path}.x`, context.limits.absoluteCoordinate);
  assertGeometryNumber(value.width, `${path}.width`, context.limits.absoluteCoordinate);
  if (value.width < 0) fail("invalid-range", path, "Run width must be nonnegative.");
  if (value.style !== undefined) assertTextStyle(value.style, `${path}.style`, true);
  return {
    textLength: value.text.length,
    bytes:
      128 +
      value.text.length * 2 +
      ((value.style as { fontFamily?: string } | undefined)?.fontFamily?.length ?? 0) * 2 +
      textBackgroundPayloadBytes(value.style as Parameters<typeof textBackgroundPayloadBytes>[0]),
  };
}

function assertFontResourceReference(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)))
    fail("invalid-range", path, "Font resource references must be lowercase SHA-256 identifiers.");
}

function* assertMath(
  value: unknown,
  sourceLength: number,
  path: string,
  context: ValidationContext,
  initialItems: number,
): Generator<void, number> {
  assertTextArray(value, MAX_TEXT_LAYOUT_ITEMS, path);
  let items = initialItems;
  let pathLength = 0;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const location = `${path}[${index}]`;
    assertRecord(entry, location);
    assertExactKeys(
      entry,
      ["start", "end", "display", "x", "y", "width", "height", "paths"],
      location,
    );
    assertBox(entry, location, context);
    assertTextSourceRange(entry, sourceLength, location);
    assertBoolean(entry.display, `${location}.display`);
    assertTextArray(entry.paths, MAX_TEXT_LAYOUT_ITEMS, `${location}.paths`);
    items += entry.paths.length + 1;
    if (items > MAX_TEXT_LAYOUT_ITEMS)
      fail("invalid-range", path, "Math layout exceeds the item limit.");
    for (let pathIndex = 0; pathIndex < entry.paths.length; pathIndex += 1) {
      const length = yield* assertMathPath(
        entry.paths[pathIndex],
        `${location}.paths[${pathIndex}]`,
      );
      pathLength += length;
      bytes += 64 + length * 2;
    }
    if (pathLength > 2_000_000) fail("invalid-range", path, "Math paths exceed the storage limit.");
  }
  return bytes;
}

function* assertMathPath(value: unknown, path: string): Generator<void, number> {
  assertRecord(value, path);
  assertExactKeys(value, ["d", ...(value.fillRule === undefined ? [] : ["fillRule"])], path);
  assertTextString(value.d, 100_000, `${path}.d`);
  try {
    yield* assertMathPathDataSteps(value.d);
  } catch {
    fail(
      "invalid-range",
      `${path}.d`,
      "Math paths require bounded normalized absolute coordinates.",
    );
  }
  if (value.fillRule !== undefined)
    assertOneOf(value.fillRule, ["nonzero", "evenodd"] as const, `${path}.fillRule`);
  return value.d.length;
}

function assertBox(value: UnknownRecord, path: string, context: ValidationContext): void {
  for (const key of ["x", "y", "width", "height"] as const)
    assertGeometryNumber(value[key], `${path}.${key}`, context.limits.absoluteCoordinate);
  if ((value.width as number) < 0 || (value.height as number) < 0)
    fail("invalid-range", path, "Layout dimensions must be nonnegative.");
}
