const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const HEX_RADIX = 16;
const ASCII_MAX = 0x7f;
const TWO_BYTE_UTF8_MAX = 0x7ff;
const TWO_UTF8_BYTES = 2;
const THREE_UTF8_BYTES = 3;
const FOUR_UTF8_BYTES = 4;

export type Utf8ByteCountResult =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly invalidOffset: number };

export function countValidUtf8Bytes(input: string): Utf8ByteCountResult {
  let bytes = 0;
  for (let offset = 0; offset < input.length; offset += 1) {
    const codeUnit = input.charCodeAt(offset);
    if (codeUnit <= ASCII_MAX) bytes += 1;
    else if (codeUnit <= TWO_BYTE_UTF8_MAX) bytes += TWO_UTF8_BYTES;
    else if (isHighSurrogate(codeUnit)) {
      if (!isLowSurrogate(input.charCodeAt(offset + 1))) {
        return Object.freeze({ ok: false, invalidOffset: offset });
      }
      bytes += FOUR_UTF8_BYTES;
      offset += 1;
    } else if (isLowSurrogate(codeUnit)) {
      return Object.freeze({ ok: false, invalidOffset: offset });
    } else bytes += THREE_UTF8_BYTES;
  }
  return Object.freeze({ ok: true, bytes });
}

export function jsonHexValue(codeUnit: number): number | undefined {
  const value = Number.parseInt(String.fromCharCode(codeUnit), HEX_RADIX);
  return Number.isNaN(value) ? undefined : value;
}

export function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= HIGH_SURROGATE_MIN && codeUnit <= HIGH_SURROGATE_MAX;
}

export function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= LOW_SURROGATE_MIN && codeUnit <= LOW_SURROGATE_MAX;
}
