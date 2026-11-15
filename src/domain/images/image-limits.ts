/** Import and storage capacities; encoded byte limits refer to decoded Base64 bytes. */
export const IMAGE_LIMITS = Object.freeze({
  resourcePixels: 16_000_000,
  defaultRasterPixels: 4_000_000,
  sourcePixels: 32_000_000,
  documentPixels: 32_000_000,
  resourceAxis: 16_384,
  sourceBytes: 16 * 1024 * 1024,
  resourceBytes: 8 * 1024 * 1024,
  documentBytes: 24 * 1024 * 1024,
  resources: 128,
  pdfSelectedPages: 20,
});
