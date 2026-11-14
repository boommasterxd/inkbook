import type { FontResourceV2 } from "../../../domain/schema/public";
import { fontStylesheetMarkupFragments } from "./text-fonts";

const CHUNK_CHARACTERS = 64 * 1024;

/** Independently bind the sole output payload to the authoritative font descriptors. */
export async function matchesCanonicalFontOutput(
  output: string | Uint8Array | undefined,
  fonts: readonly FontResourceV2[],
  checkpoint: () => Promise<void> | undefined,
): Promise<boolean> {
  if (output === undefined) return fonts.length === 0;
  const prefix =
    typeof output === "string"
      ? output.slice(0, 4096)
      : new TextDecoder().decode(output.subarray(0, 4096));
  const themeEnd = prefix.indexOf("</style>");
  if (themeEnd < 0) return false;
  let offset = themeEnd + 8;
  let work = 0;
  for (const token of expectedTokens(fonts)) {
    for (let start = 0; start < token.length;) {
      const end = Math.min(token.length, start + CHUNK_CHARACTERS - work);
      if (!matchesChunk(output, offset - start, token, start, end)) return false;
      work += end - start;
      offset += end - start;
      start = end;
      if (work === CHUNK_CHARACTERS) {
        const pending = checkpoint();
        if (pending !== undefined) await pending;
        work = 0;
      }
    }
  }
  const pending = checkpoint();
  if (pending !== undefined) await pending;
  return true;
}

function* expectedTokens(fonts: readonly FontResourceV2[]): Iterable<string> {
  yield* fontStylesheetMarkupFragments(fonts);
  yield "<metadata ";
}

function matchesChunk(
  output: string | Uint8Array,
  offset: number,
  expected: string,
  start: number,
  end: number,
): boolean {
  if (typeof output === "string")
    return output.slice(offset + start, offset + end) === expected.slice(start, end);
  for (let index = start; index < end; index++) {
    if (output[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}
