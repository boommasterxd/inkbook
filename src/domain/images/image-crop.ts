import { canonicalizeGeometryNumber } from "../schema/canonical";
import type { ImageCropV3, ImageElementV3 } from "../schema/types";
import { rotatePointClockwise } from "../geometry/primitives";

/** Keeps the retained pixels stationary, including when restoring a larger source crop. */
export function applyImageCrop(image: ImageElementV3, crop: ImageCropV3): ImageElementV3 {
  const next = {
    x: canonicalizeGeometryNumber(crop.x),
    y: canonicalizeGeometryNumber(crop.y),
    width: canonicalizeGeometryNumber(crop.width),
    height: canonicalizeGeometryNumber(crop.height),
  };
  if (next.x < 0 || next.y < 0 || next.width <= 0 || next.height <= 0) {
    throw new RangeError("Image crops must have a non-negative origin and positive dimensions.");
  }
  const scaleX = image.width / image.crop.width;
  const scaleY = image.height / image.crop.height;
  const width = canonicalizeGeometryNumber(next.width * scaleX);
  const height = canonicalizeGeometryNumber(next.height * scaleY);
  if (width <= 0 || height <= 0) throw new RangeError("Image crops must retain visible geometry.");
  const center = rotatePointClockwise(
    {
      x: image.x + (next.x - image.crop.x) * scaleX + width / 2,
      y: image.y + (next.y - image.crop.y) * scaleY + height / 2,
    },
    image.pivot,
    image.rotation,
  );
  const pivot = {
    x: canonicalizeGeometryNumber(center.x),
    y: canonicalizeGeometryNumber(center.y),
  };
  return {
    ...image,
    crop: next,
    x: canonicalizeGeometryNumber(pivot.x - width / 2),
    y: canonicalizeGeometryNumber(pivot.y - height / 2),
    width,
    height,
    pivot,
  };
}
