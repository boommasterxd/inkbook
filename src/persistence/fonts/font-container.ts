export type FontMimeType = "font/ttf" | "font/otf" | "font/woff" | "font/woff2";

export const FONT_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  decodedBytes: 32 * 1024 * 1024,
  tables: 128,
  libraryFaces: 128,
  documentFaces: 64,
  documentBytes: 32 * 1024 * 1024,
});

export interface FontContainer {
  readonly mimeType: FontMimeType;
  readonly decodedBytes: number;
  readonly tables: number;
}

export function invalidFont(): never {
  throw new RangeError("Invalid or unsupported font container.");
}

export function assertFontRange(offset: number, length: number, maximum: number): void {
  if (offset < 0 || length <= 0 || offset > maximum - length) invalidFont();
}

export function fontTag(view: DataView, offset: number): string {
  return String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4));
}

export function assertFontTables(tags: ReadonlySet<string>): void {
  for (const tag of ["cmap", "head", "hhea", "hmtx", "maxp", "name"]) {
    if (!tags.has(tag)) invalidFont();
  }
  if (!tags.has("glyf") && !tags.has("CFF ") && !tags.has("CFF2")) invalidFont();
  if (tags.has("glyf") && !tags.has("loca")) invalidFont();
}
