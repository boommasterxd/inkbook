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

export function* decodeMetadataTextSteps(input: string): Generator<void, string | null> {
  const decodedChunks: string[] = [];
  let currentParts: string[] = [];
  let cursor = 0;
  let literalStart = 0;
  let sliceStart = 0;
  while (cursor < input.length) {
    const character = input[cursor];
    if (character === "<") return null;
    if (character === "&") {
      currentParts.push(input.slice(literalStart, cursor));
      const entity = decodeAllowedEntity(input, cursor);
      if (entity === null) return null;
      currentParts.push(entity.value);
      cursor = entity.next;
      literalStart = cursor;
    } else {
      cursor += 1;
    }
    if (cursor - sliceStart >= METADATA_DECODE_CODE_UNITS_PER_STEP) {
      currentParts.push(input.slice(literalStart, cursor));
      decodedChunks.push(currentParts.join(""));
      currentParts = [];
      literalStart = cursor;
      sliceStart = cursor;
      yield;
    }
  }
  currentParts.push(input.slice(literalStart));
  decodedChunks.push(currentParts.join(""));
  return decodedChunks.join("");
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
