import type { FontResourceV2 } from "../../domain/schema/public";

export interface SafeSvgFontFace {
  readonly family: string;
  readonly style: "normal" | "italic";
  readonly weight: number;
  readonly weightRange?: [number, number];
  readonly mimeType: FontResourceV2["mimeType"];
  readonly data: string;
}

export const MAXIMUM_FONT_STYLESHEET_CHARACTERS = 48 * 1024 * 1024;
const FONT_PREFIX =
  /^@font-face\{font-family:"(inkbook-[a-z][a-z0-9-]{0,95})";font-style:(normal|italic);font-weight:([1-9]\d{0,3}(?: [1-9]\d{0,3})?);src:url\("data:(font\/(?:woff2|woff|ttf|otf));base64,/u;
const FORMATS: Readonly<Record<string, string>> = {
  "font/woff2": "woff2",
  "font/woff": "woff",
  "font/ttf": "truetype",
  "font/otf": "opentype",
};
const SLICE_CHARACTERS = 16 * 1024;

/** Observed faces remain provisional until complete stylesheet validation returns true. */
export function* validateFontStylesheetSteps(
  input: string,
  observeFace?: (face: SafeSvgFontFace) => void,
): Generator<void, boolean> {
  if (input.length === 0 || input.length > MAXIMUM_FONT_STYLESHEET_CHARACTERS) return false;
  const faces = new Set<string>();
  let cursor = 0;
  while (cursor < input.length) {
    const prefix = FONT_PREFIX.exec(input.slice(cursor, cursor + 512));
    if (prefix === null) return false;
    const weights = prefix[3]!.split(" ").map(Number);
    if (
      weights.some((weight) => weight > 1000) ||
      (weights.length === 2 && weights[0]! > weights[1]!)
    )
      return false;
    const identity = `${prefix[1]}:${prefix[2]}:${prefix[3]}`;
    if (faces.has(identity) || faces.size === 128) return false;
    faces.add(identity);
    const start = cursor + prefix[0].length;
    const end = yield* findFontDataEndSteps(input, start);
    if (end <= start || (end - start) % 4 !== 0) return false;
    const suffix = `") format("${FORMATS[prefix[4]!]}")}`;
    if (!input.startsWith(suffix, end)) return false;
    if (!(yield* validateBase64Steps(input, start, end))) return false;
    if (observeFace !== undefined)
      observeFace({
        family: prefix[1]!.slice("inkbook-".length),
        style: prefix[2] as SafeSvgFontFace["style"],
        weight: weights[0]!,
        ...(weights.length === 2
          ? { weightRange: [weights[0]!, weights[1]!] as [number, number] }
          : {}),
        mimeType: prefix[4] as FontResourceV2["mimeType"],
        data: input.slice(start, end),
      });
    cursor = end + suffix.length;
  }
  return true;
}

function* findFontDataEndSteps(input: string, start: number): Generator<void, number> {
  for (let cursor = start; cursor < input.length; cursor += SLICE_CHARACTERS) {
    const quote = input.slice(cursor, cursor + SLICE_CHARACTERS).indexOf('"');
    if (quote >= 0) return cursor + quote;
    yield;
  }
  return -1;
}

function* validateBase64Steps(input: string, start: number, end: number): Generator<void, boolean> {
  const padding = input[end - 1] === "=" ? (input[end - 2] === "=" ? 2 : 1) : 0;
  for (let offset = start; offset < end - padding; offset += SLICE_CHARACTERS) {
    if (
      !/^[A-Za-z0-9+/]+$/u.test(
        input.slice(offset, Math.min(offset + SLICE_CHARACTERS, end - padding)),
      )
    )
      return false;
    yield;
  }
  if (padding === 2 && !/[AQgw]/u.test(input[end - 3]!)) return false;
  return padding !== 1 || /[AEIMQUYcgkosw048]/u.test(input[end - 2]!);
}
