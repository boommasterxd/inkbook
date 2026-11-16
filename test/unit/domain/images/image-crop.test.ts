import { describe, expect, it } from "vitest";
import { applyImageCrop } from "../../../../src/domain/images/image-crop";
import { rotatePointClockwise } from "../../../../src/domain/geometry/public";
import type { ImageElementV3, PointV1 } from "../../../../src/domain/schema/public";
import { imageElement } from "../../../fixtures/domain/images";

function pixelWorld(image: ImageElementV3, pixel: PointV1): PointV1 {
  return rotatePointClockwise(
    {
      x: image.x + ((pixel.x - image.crop.x) * image.width) / image.crop.width,
      y: image.y + ((pixel.y - image.crop.y) * image.height) / image.crop.height,
    },
    image.pivot,
    image.rotation,
  );
}

describe("nondestructive image cropping", () => {
  it.each([0, 37, 90, -123])(
    "preserves retained source pixels and supports reset at %d degrees",
    (rotation) => {
      const image = { ...imageElement(), rotation };
      const cropped = applyImageCrop(image, { x: 80, y: 20, width: 200, height: 120 });
      expect(cropped).toMatchObject({ width: 100, height: 60, assetId: image.assetId });
      for (const pixel of [
        { x: 80, y: 20 },
        { x: 200, y: 100 },
        { x: 280, y: 140 },
      ]) {
        const before = pixelWorld(image, pixel);
        const after = pixelWorld(cropped, pixel);
        expect(after.x).toBeCloseTo(before.x, 2);
        expect(after.y).toBeCloseTo(before.y, 2);
      }
      const reset = applyImageCrop(cropped, image.crop);
      expect(reset.width).toBe(image.width);
      expect(reset.height).toBe(image.height);
      expect(reset.x).toBeCloseTo(image.x, 2);
      expect(reset.y).toBeCloseTo(image.y, 2);
      expect(image.crop).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    },
  );

  it("canonicalizes crop geometry and rejects empty/nonfinite crops", () => {
    expect(applyImageCrop(imageElement(), { x: 1.0001, y: 2, width: 10, height: 20 }).crop.x).toBe(
      1,
    );
    for (const invalid of [{ x: -1 }, { width: 0 }, { width: 0.0001 }, { height: Infinity }])
      expect(() => applyImageCrop(imageElement(), { ...imageElement().crop, ...invalid })).toThrow(
        RangeError,
      );
  });
});
