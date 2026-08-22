export function utf8ByteLengthWithinLimit(input: string, maximumBytes: number): number | null {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("UTF-8 byte limit must be a non-negative safe integer.");
  }
  let bytes = 0;
  for (let index = 0; index < input.length; index += 1) {
    const value = input.charCodeAt(index);
    if (value <= 0x7f) bytes += 1;
    else if (value <= 0x7ff) bytes += 2;
    else if (value >= 0xd800 && value <= 0xdbff && isLowSurrogate(input, index + 1)) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > maximumBytes) return null;
  }
  return bytes;
}

function isLowSurrogate(input: string, index: number): boolean {
  const value = input.charCodeAt(index);
  return value >= 0xdc00 && value <= 0xdfff;
}
