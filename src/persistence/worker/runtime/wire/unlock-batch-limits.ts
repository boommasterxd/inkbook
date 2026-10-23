import type { InkElementV1 } from "../../../../domain/schema/public";
import { isNativeArrayBuffer, isNativeFloat64Array } from "../../../serialization/transfer-array";

import type { PackedElements } from "./element-wire-codec";

export const MAX_UNLOCK_BATCH_ELEMENTS = 256;
export const MAX_UNLOCK_BATCH_POINT_BYTES = 4 * 1024 * 1024;

export function strokePointByteLength(element: InkElementV1): number {
  return element.kind === "stroke" ? element.points.length * Float64Array.BYTES_PER_ELEMENT : 0;
}

export function assertUnlockBatchWireLimits(elements: PackedElements): void {
  if (elements.records.length > MAX_UNLOCK_BATCH_ELEMENTS) {
    throw new RangeError("Worker unlock batch exceeds the element limit.");
  }
  if (elements.pointBuffers.length > elements.records.length) {
    throw new RangeError("Worker unlock batch contains excessive point buffers.");
  }
  let pointBytes = 0;
  const backingBuffers = new Set<ArrayBuffer>();
  for (const points of elements.pointBuffers) {
    if (
      !isNativeFloat64Array(points) ||
      !isNativeArrayBuffer(points.buffer) ||
      points.byteOffset !== 0 ||
      points.byteLength !== points.buffer.byteLength
    ) {
      throw new TypeError("Worker unlock batch point buffers must use Float64Array values.");
    }
    if (backingBuffers.has(points.buffer)) {
      throw new RangeError("Worker unlock batch point buffers must have exclusive backing stores.");
    }
    backingBuffers.add(points.buffer);
    pointBytes += points.byteLength;
    if (pointBytes > MAX_UNLOCK_BATCH_POINT_BYTES) {
      throw new RangeError("Worker unlock batch exceeds the point-buffer byte limit.");
    }
  }
}
