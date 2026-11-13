import { assertFontRange, invalidFont } from "./font-container";

/** Reads an actual typographic family name, preferring Unicode English records. */
export function readFontFamilyName(bytes: Uint8Array): string | undefined {
  if (bytes.length < 6) invalidFont();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const count = view.getUint16(2);
  const strings = view.getUint16(4);
  if (count > 2048 || 6 + count * 12 > bytes.length || strings > bytes.length) invalidFont();
  let best: { score: number; name: string } | undefined;
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 12;
    const platform = view.getUint16(offset);
    const nameId = view.getUint16(offset + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = view.getUint16(offset + 8);
    const start = strings + view.getUint16(offset + 10);
    if (length === 0 || length > 512) continue;
    assertFontRange(start, length, bytes.length);
    const name = decodeName(bytes.subarray(start, start + length), platform);
    if (name === undefined) continue;
    const score =
      (nameId === 16 ? 100 : 0) +
      (platform === 3 ? 10 : 0) +
      (view.getUint16(offset + 4) === 0x0409 ? 5 : 0);
    if (best === undefined || score > best.score) best = { score, name };
  }
  return best?.name;
}

function decodeName(bytes: Uint8Array, platform: number): string | undefined {
  if (platform !== 0 && platform !== 1 && platform !== 3) return undefined;
  try {
    const name = new TextDecoder(platform === 1 ? "macintosh" : "utf-16be", { fatal: true })
      .decode(bytes)
      .split("")
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join("")
      .trim();
    return name.length > 0 && name.length <= 128 ? name : undefined;
  } catch {
    return undefined;
  }
}

export function readFontWeightRange(bytes: Uint8Array): [number, number] | undefined {
  if (bytes.length < 16) invalidFont();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const start = view.getUint16(4);
  const count = view.getUint16(8);
  const stride = view.getUint16(10);
  if (count > 64 || stride < 20 || start + count * stride > bytes.length) invalidFont();
  for (let index = 0; index < count; index += 1) {
    const offset = start + index * stride;
    if (view.getUint32(offset) !== 0x77676874) continue;
    const minimum = view.getInt32(offset + 4) / 65536;
    const maximum = view.getInt32(offset + 12) / 65536;
    if (
      !Number.isInteger(minimum) ||
      !Number.isInteger(maximum) ||
      minimum < 1 ||
      maximum > 1000 ||
      minimum > maximum
    )
      invalidFont();
    return [minimum, maximum];
  }
  return undefined;
}
