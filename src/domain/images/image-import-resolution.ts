export const IMAGE_IMPORT_RESOLUTIONS = [
  { id: "standard", dpi: 72, maximumPixels: 2_000_000 },
  { id: "high", dpi: 144, maximumPixels: 4_000_000 },
  { id: "very-high", dpi: 300, maximumPixels: 9_000_000 },
  { id: "ultra", dpi: 400, maximumPixels: 16_000_000 },
] as const;

export type ImageImportResolution = (typeof IMAGE_IMPORT_RESOLUTIONS)[number];

/** Unknown transient UI values retain the established 144-dpi and 4-MP default. */
export function imageImportResolution(value: string): ImageImportResolution {
  return (
    IMAGE_IMPORT_RESOLUTIONS.find((resolution) => resolution.id === value) ??
    IMAGE_IMPORT_RESOLUTIONS[1]
  );
}
