import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import { inspectWebpHeaderSteps } from "./webp-header";

export interface ImageHeader {
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly lossless?: boolean;
}

export class ImageHeaderError extends RangeError {
  public constructor(public readonly reason: "format" | "dimensions") {
    super("Invalid or unsupported raster image.");
  }
}

/** Admit only bounded raster containers; native image decoding remains the import adapter's job. */
export function* inspectImageHeaderSteps(
  bytes: Uint8Array,
  options?: { readonly source: boolean },
): Generator<void, ImageHeader> {
  const maximumBytes =
    options?.source === true ? IMAGE_LIMITS.sourceBytes : IMAGE_LIMITS.resourceBytes;
  if (bytes.length < 24 || bytes.length > maximumBytes) invalidImage();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: ImageHeader;
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) invalidImage();
    header = { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  } else if (view.getUint32(0) === 0x52494646) {
    const dimensions = yield* inspectWebpHeaderSteps(view);
    if (dimensions === null) invalidImage();
    header = { mimeType: "image/webp", ...dimensions };
  } else header = yield* inspectJpegSteps(view);
  if (header.width < 1 || header.height < 1) invalidImage();
  const maximumPixels =
    options?.source === true ? IMAGE_LIMITS.sourcePixels : IMAGE_LIMITS.resourcePixels;
  if (
    header.width > IMAGE_LIMITS.resourceAxis ||
    header.height > IMAGE_LIMITS.resourceAxis ||
    header.width * header.height > maximumPixels
  )
    invalidImage("dimensions");
  return header;
}

function* inspectJpegSteps(view: DataView): Generator<void, ImageHeader> {
  if (view.getUint16(0) !== 0xffd8) invalidImage();
  let offset = 2;
  let checkpointOffset = 4096;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset++) !== 0xff) invalidImage();
    while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset++;
    const marker = view.getUint8(offset++);
    if (marker === 0xd9 || marker === 0xda || marker === 0 || marker === 0xd8) invalidImage();
    if (offset + 2 > view.byteLength) invalidImage();
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength) invalidImage();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || view.getUint8(offset + 2) !== 8) invalidImage();
      return {
        mimeType: "image/jpeg",
        width: view.getUint16(offset + 5),
        height: view.getUint16(offset + 3),
      };
    }
    offset += length;
    if (offset >= checkpointOffset) {
      yield;
      checkpointOffset = offset + 4096;
    }
  }
  return invalidImage();
}

function invalidImage(reason: ImageHeaderError["reason"] = "format"): never {
  throw new ImageHeaderError(reason);
}
