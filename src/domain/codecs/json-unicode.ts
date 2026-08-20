const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const HEX_RADIX = 16;

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
