import {
  assertFontRange,
  assertFontTables,
  FONT_LIMITS,
  fontTag,
  invalidFont,
  type FontContainer,
} from "./font-container";

const TAGS =
  "cmap head hhea hmtx maxp name OS/2 post cvt\u0020 fpgm glyf loca prep CFF\u0020 VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG\u0020 sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill";
const KNOWN_TAGS = TAGS.match(/.{4}(?: |$)/g)?.map((tag) => tag.slice(0, 4)) ?? [];

export interface Woff2Table {
  readonly tag: string;
  readonly length: number;
  readonly decodedLength: number;
  readonly decodedOffset: number;
}

export interface Woff2Directory {
  readonly tables: readonly Woff2Table[];
  readonly compressedOffset: number;
  readonly compressedBytes: number;
  readonly decodedBytes: number;
}

export function inspectWoff2(view: DataView): FontContainer {
  const directory = readWoff2Directory(view);
  return {
    mimeType: "font/woff2",
    decodedBytes: view.getUint32(16),
    tables: directory.tables.length,
  };
}

export function readWoff2Directory(view: DataView): Woff2Directory {
  validateHeader(view);
  const tables = view.getUint16(12);
  const decodedBytes = view.getUint32(16);
  const cursor = { offset: 48 };
  const tags = new Set<string>();
  let expected = 12 + tables * 16;
  let transformedBytes = 0;
  const entries: Woff2Table[] = [];
  for (let index = 0; index < tables; index += 1) {
    const entry = readEntry(view, cursor);
    if (tags.has(entry.tag)) invalidFont();
    tags.add(entry.tag);
    expected += Math.ceil(entry.length / 4) * 4;
    entries.push({ ...entry, decodedOffset: transformedBytes });
    transformedBytes += entry.decodedLength;
    if (transformedBytes > FONT_LIMITS.decodedBytes) invalidFont();
  }
  if (expected !== decodedBytes) invalidFont();
  assertFontRange(cursor.offset, view.getUint32(20), view.byteLength);
  assertFontTables(tags);
  return {
    tables: entries,
    compressedOffset: cursor.offset,
    compressedBytes: view.getUint32(20),
    decodedBytes: transformedBytes,
  };
}

function validateHeader(view: DataView): void {
  if (view.byteLength < 48 || view.getUint32(8) !== view.byteLength || view.getUint16(14) !== 0)
    invalidFont();
  if (view.getUint32(4) !== 0x00010000 && fontTag(view, 4) !== "OTTO") invalidFont();
  const tables = view.getUint16(12);
  if (tables < 1 || tables > FONT_LIMITS.tables || view.getUint32(16) > FONT_LIMITS.decodedBytes)
    invalidFont();
}

function readEntry(
  view: DataView,
  cursor: { offset: number },
): { tag: string; length: number; decodedLength: number } {
  if (cursor.offset >= view.byteLength) invalidFont();
  const flags = view.getUint8(cursor.offset++);
  const known = flags & 63;
  if (known === 63 && cursor.offset + 4 > view.byteLength) invalidFont();
  const tag = known === 63 ? fontTag(view, cursor.offset) : KNOWN_TAGS[known];
  if (known === 63) cursor.offset += 4;
  if (tag === undefined || !/^[\x20-\x7e]{4}$/.test(tag)) return invalidFont();
  const length = base128(view, cursor);
  if (length === 0) invalidFont();
  const transformed = validateTransform(view, cursor, tag, flags >>> 6);
  return { tag, length, decodedLength: transformed ?? length };
}

function validateTransform(
  view: DataView,
  cursor: { offset: number },
  tag: string,
  version: number,
): number | undefined {
  const outline = tag === "glyf" || tag === "loca";
  const transformed = outline ? version !== 3 : version !== 0;
  if (outline && version !== 0 && version !== 3) invalidFont();
  if (!outline && version !== 0 && !(tag === "hmtx" && version === 1)) invalidFont();
  if (!transformed) return undefined;
  const length = base128(view, cursor);
  if (tag === "loca" && length !== 0) invalidFont();
  if (length > FONT_LIMITS.decodedBytes) invalidFont();
  return length;
}

function base128(view: DataView, cursor: { offset: number }): number {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    if (cursor.offset >= view.byteLength) invalidFont();
    const byte = view.getUint8(cursor.offset++);
    if ((index === 0 && byte === 128) || value > 0x1ffffff) invalidFont();
    value = value * 128 + (byte & 127);
    if ((byte & 128) === 0) return value;
  }
  return invalidFont();
}
