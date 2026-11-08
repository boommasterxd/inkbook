const METADATA_CODE_UNITS_PER_STEP = 256 * 1024;
const METADATA_DECODE_CODE_UNITS_PER_STEP = 16 * 1024;

export function* measureUtf8BytesSteps(input: string): Generator<void, number> {
  const encoder = new TextEncoder();
  let bytes = 0;
  let start = 0;
  while (start < input.length) {
    let end = Math.min(start + METADATA_CODE_UNITS_PER_STEP, input.length);
    const trailing = input.charCodeAt(end - 1);
    if (end < input.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
    bytes += encoder.encode(input.slice(start, end)).byteLength;
    start = end;
    if (start < input.length) yield;
  }
  return bytes;
}

interface DecodedMetadataText {
  readonly text: string;
  readonly entityByteSavings: number;
}

export function* decodeMetadataTextSteps(
  input: string,
): Generator<void, DecodedMetadataText | null> {
  const decodedChunks: string[] = [];
  let cursor = 0;
  let entityByteSavings = 0;
  while (cursor < input.length) {
    const end = Math.min(cursor + METADATA_DECODE_CODE_UNITS_PER_STEP, input.length);
    const decoded = decodeMetadataSlice(input, cursor, end);
    if (decoded === null) return null;
    decodedChunks.push(decoded.text);
    entityByteSavings += decoded.entityByteSavings;
    cursor = decoded.next;
    if (cursor < input.length) yield;
  }
  return { text: decodedChunks.join(""), entityByteSavings };
}

function decodeMetadataSlice(
  input: string,
  start: number,
  end: number,
): (DecodedMetadataText & { readonly next: number }) | null {
  const slice = input.slice(start, end);
  if (slice.includes("<")) return null;
  const parts: string[] = [];
  let literalStart = start;
  let entityByteSavings = 0;
  let offset = slice.indexOf("&");
  while (offset >= 0) {
    const entityStart = start + offset;
    const entity = decodeAllowedEntity(input, entityStart);
    if (entity === null) return null;
    parts.push(input.slice(literalStart, entityStart), entity.value);
    // Allowlisted entities and their replacements are ASCII, so UTF-8 byte savings are exact.
    entityByteSavings += entity.next - entityStart - entity.value.length;
    literalStart = entity.next;
    offset = slice.indexOf("&", literalStart - start);
  }
  parts.push(input.slice(literalStart, end));
  return { text: parts.join(""), entityByteSavings, next: Math.max(end, literalStart) };
}

function decodeAllowedEntity(
  input: string,
  start: number,
): { readonly next: number; readonly value: string } | null {
  if (input.startsWith("&amp;", start)) return { next: start + 5, value: "&" };
  if (input.startsWith("&lt;", start)) return { next: start + 4, value: "<" };
  if (input.startsWith("&gt;", start)) return { next: start + 4, value: ">" };
  return null;
}
