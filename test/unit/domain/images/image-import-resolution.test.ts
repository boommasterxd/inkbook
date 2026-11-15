import { expect, it } from "vitest";
import {
  IMAGE_IMPORT_RESOLUTIONS,
  imageImportResolution,
} from "../../../../src/domain/images/image-import-resolution";
import { fitImageRasterSize } from "../../../../src/domain/images/image-raster-size";
import { IMAGE_LIMITS } from "../../../../src/domain/images/image-limits";

it("resolves bounded quality profiles and retains the established fallback and default", () => {
  for (const profile of IMAGE_IMPORT_RESOLUTIONS) {
    expect(imageImportResolution(profile.id)).toBe(profile);
    const size = fitImageRasterSize(5040, 5040, 1, profile.maximumPixels);
    expect(size.width * size.height).toBeLessThanOrEqual(profile.maximumPixels);
    expect(size.width).toBe(Math.floor(Math.sqrt(profile.maximumPixels)));
  }
  expect(imageImportResolution("unknown")).toBe(imageImportResolution("high"));
  expect(fitImageRasterSize(5040, 5040)).toEqual({
    width: 2000,
    height: 2000,
    scale: 2000 / 5040,
  });
});

it("keeps original raster detail without upscaling and bounds explicit budgets by storage capacity", () => {
  expect(fitImageRasterSize(100, 50, 1, 16_000_000)).toEqual({
    width: 100,
    height: 50,
    scale: 1,
  });
  const maximum = fitImageRasterSize(8000, 4000, 1, IMAGE_LIMITS.sourcePixels);
  expect(maximum.width * maximum.height).toBeLessThanOrEqual(IMAGE_LIMITS.resourcePixels);
  const narrow = fitImageRasterSize(1, 16000, 2, IMAGE_LIMITS.resourcePixels);
  expect(narrow.height).toBe(IMAGE_LIMITS.resourceAxis);
});

it("rejects invalid geometry and resolution budgets before native consumers allocate", () => {
  for (const budget of [0, -1, 0.5, NaN, Infinity]) {
    expect(() => fitImageRasterSize(100, 100, 1, budget)).toThrow(RangeError);
  }
  for (const [width, height, scale] of [
    [0, 100, 1],
    [100, NaN, 1],
    [100, 100, -1],
  ] as const) {
    expect(() => fitImageRasterSize(width, height, scale)).toThrow(RangeError);
  }
});
