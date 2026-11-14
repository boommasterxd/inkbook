import {
  assertFontRange,
  assertFontTables,
  FONT_LIMITS,
  fontTag,
  invalidFont,
  type FontContainer,
} from "./font-container";
import { inspectWoff2 } from "./woff2-directory";

/** Structural admission precedes mandatory native FontFace sanitization on import. */
export function inspectFont(bytes: Uint8Array): FontContainer {
  if (bytes.byteLength < 12 || bytes.byteLength > FONT_LIMITS.fileBytes) invalidFont();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = fontTag(view, 0);
  if (signature === "wOF2") return inspectWoff2(view);
  if (signature === "wOFF") return inspectWoff(view);
  if (view.getUint32(0) !== 0x00010000 && signature !== "OTTO") invalidFont();
  const tables = view.getUint16(4);
  validateTableCount(tables, 12, 16, bytes.length);
  const tags = new Set<string>();
  const ranges: [number, number][] = [];
  for (let index = 0; index < tables; index += 1) {
    const offset = 12 + index * 16;
    const tag = fontTag(view, offset);
    const start = view.getUint32(offset + 8);
    const length = view.getUint32(offset + 12);
    admitTable(tags, tag);
    assertFontRange(start, length, bytes.length);
    if (start < 12 + tables * 16 || start % 4 !== 0) invalidFont();
    ranges.push([start, start + length]);
  }
  assertNonoverlapping(ranges);
  assertFontTables(tags);
  return {
    mimeType: signature === "OTTO" ? "font/otf" : "font/ttf",
    tables,
    decodedBytes: bytes.length,
  };
}

function inspectWoff(view: DataView): FontContainer {
  if (view.byteLength < 44 || view.getUint32(8) !== view.byteLength || view.getUint16(14) !== 0)
    invalidFont();
  const tables = view.getUint16(12);
  validateTableCount(tables, 44, 20, view.byteLength);
  const decodedBytes = view.getUint32(16);
  if (decodedBytes > FONT_LIMITS.decodedBytes) invalidFont();
  const tags = new Set<string>();
  const ranges: [number, number][] = [];
  let expected = 12 + tables * 16;
  for (let index = 0; index < tables; index += 1) {
    const offset = 44 + index * 20;
    admitTable(tags, fontTag(view, offset));
    const start = view.getUint32(offset + 4);
    const compressed = view.getUint32(offset + 8);
    const original = view.getUint32(offset + 12);
    assertFontRange(start, compressed, view.byteLength);
    if (start < 44 + tables * 20 || start % 4 !== 0 || compressed > original) invalidFont();
    expected += Math.ceil(original / 4) * 4;
    ranges.push([start, start + compressed]);
  }
  if (expected !== decodedBytes) invalidFont();
  assertNonoverlapping(ranges);
  assertFontTables(tags);
  return { mimeType: "font/woff", decodedBytes, tables };
}

function validateTableCount(count: number, header: number, stride: number, bytes: number): void {
  if (count < 1 || count > FONT_LIMITS.tables || header + count * stride > bytes) invalidFont();
}

function admitTable(tags: Set<string>, tag: string): void {
  if (!/^[\x20-\x7e]{4}$/.test(tag) || tags.has(tag)) invalidFont();
  tags.add(tag);
}

function assertNonoverlapping(ranges: [number, number][]): void {
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]![0] < ranges[index - 1]![1]) invalidFont();
  }
}
