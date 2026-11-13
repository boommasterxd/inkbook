import {
  assertTextArray,
  assertTextString,
  assertTextFontFamily,
} from "./text-validation-primitives";
import {
  assertExactKeys,
  assertIntegerRange,
  assertOneOf,
  assertRecord,
  fail,
} from "./validation-internals";

/** Container shape only; font decoders separately validate binary tables before loading. */
export function* assertFontResourcesSteps(value: unknown, path: string): Generator<void, void> {
  assertTextArray(value, 64, path);
  const ids = new Set<string>();
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const resource: unknown = value[index];
    const location = `${path}[${index}]`;
    assertRecord(resource, location);
    assertExactKeys(
      resource,
      [
        "id",
        "family",
        "weight",
        "style",
        "mimeType",
        "data",
        ...(resource.license === undefined ? [] : ["license"]),
        ...(resource.weightRange === undefined ? [] : ["weightRange"]),
      ],
      location,
    );
    assertTextString(resource.id, 128, `${location}.id`, false);
    if (!/^[a-zA-Z0-9_-]+$/.test(resource.id))
      fail("invalid-range", `${location}.id`, "Font identifiers must be ASCII identifiers.");
    if (ids.has(resource.id))
      fail("duplicate-id", `${location}.id`, "Duplicate font resource identifier.");
    ids.add(resource.id);
    assertTextFontFamily(resource.family, `${location}.family`);
    assertIntegerRange(resource.weight, 1, 1000, `${location}.weight`);
    if (resource.weightRange !== undefined) {
      assertTextArray(resource.weightRange, 2, `${location}.weightRange`);
      if (resource.weightRange.length !== 2)
        fail("invalid-range", `${location}.weightRange`, "Font weight range requires two bounds.");
      assertIntegerRange(resource.weightRange[0], 1, 1000, `${location}.weightRange[0]`);
      assertIntegerRange(
        resource.weightRange[1],
        resource.weightRange[0],
        1000,
        `${location}.weightRange[1]`,
      );
    }
    assertOneOf(resource.style, ["normal", "italic"] as const, `${location}.style`);
    assertOneOf(
      resource.mimeType,
      ["font/woff2", "font/woff", "font/ttf", "font/otf"] as const,
      `${location}.mimeType`,
    );
    yield* assertFontDataSteps(resource.data, `${location}.data`);
    bytes += (resource.data as string).length;
    if (bytes > 32 * 1024 * 1024)
      fail("invalid-range", path, "Font resources exceed the aggregate size limit.");
    if (resource.license !== undefined)
      assertTextString(resource.license, 16_384, `${location}.license`);
  }
}

function* assertFontDataSteps(value: unknown, path: string): Generator<void, void> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8 * 1024 * 1024 ||
    value.length % 4 !== 0
  )
    fail("invalid-range", path, "Font resources must use bounded Base64 data.");
  for (let offset = 0; offset < value.length; offset += 65_536) {
    const chunk = value.slice(offset, offset + 65_536);
    const final = offset + chunk.length === value.length;
    if (!(final ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(chunk))
      fail("invalid-range", path, "Font resources must use bounded Base64 data.");
    yield;
  }
}
