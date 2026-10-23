import { CLIPBOARD_SCHEMA_LIMITS, FILE_SCHEMA_LIMITS } from "../../../../domain/schema/constants";
import { isNativeArrayBuffer, isNativeFloat64Array } from "../../../serialization/transfer-array";

import type { PackedElements } from "./element-wire-codec";

const MAX_CLIPBOARD_POINT_BYTES =
  CLIPBOARD_SCHEMA_LIMITS.strokePoints * 3 * Float64Array.BYTES_PER_ELEMENT;
const MAX_DOCUMENT_POINT_BYTES =
  FILE_SCHEMA_LIMITS.strokePoints * 3 * Float64Array.BYTES_PER_ELEMENT;

export function assertClipboardElementWireLimits(elements: PackedElements): void {
  assertPackedElementWireLimits(
    elements.records.length,
    elements.pointBuffers,
    CLIPBOARD_SCHEMA_LIMITS.elements,
    MAX_CLIPBOARD_POINT_BYTES,
  );
}

export function assertClipboardPayloadWireLimits(
  elementCount: number,
  pointBuffers: readonly Float64Array[],
): void {
  assertPackedElementWireLimits(
    elementCount,
    pointBuffers,
    CLIPBOARD_SCHEMA_LIMITS.elements,
    MAX_CLIPBOARD_POINT_BYTES,
  );
}

function assertPackedElementWireLimits(
  elementCount: number,
  pointBuffers: readonly Float64Array[],
  maximumElements: number,
  maximumPointBytes: number,
): void {
  const steps = packedElementWireLimitSteps(
    elementCount,
    pointBuffers,
    maximumElements,
    maximumPointBytes,
  );
  while (!steps.next().done) {
    // The synchronous boundary consumes the same validation producer.
  }
}

function* packedElementWireLimitSteps(
  elementCount: number,
  pointBuffers: readonly Float64Array[],
  maximumElements: number,
  maximumPointBytes: number,
): Generator<void> {
  if (elementCount < 0 || elementCount > maximumElements) {
    throw new RangeError("Worker element transfer exceeds the element limit.");
  }
  if (pointBuffers.length > elementCount) {
    throw new RangeError("Worker element transfer contains excessive point buffers.");
  }
  let pointBytes = 0;
  const backingBuffers = new Set<ArrayBuffer>();
  for (const points of pointBuffers) {
    if (
      !isNativeFloat64Array(points) ||
      !isNativeArrayBuffer(points.buffer) ||
      points.byteOffset !== 0 ||
      points.byteLength !== points.buffer.byteLength
    ) {
      throw new TypeError("Worker point buffers must exclusively own full-span arrays.");
    }
    if (backingBuffers.has(points.buffer)) {
      throw new RangeError("Worker point buffers must have exclusive backing stores.");
    }
    backingBuffers.add(points.buffer);
    pointBytes += points.byteLength;
    if (pointBytes > maximumPointBytes) {
      throw new RangeError("Worker element transfer exceeds the point-buffer byte limit.");
    }
    yield;
  }
}

export function documentElementWireLimitSteps(elements: PackedElements): Generator<void> {
  return packedElementWireLimitSteps(
    elements.records.length,
    elements.pointBuffers,
    FILE_SCHEMA_LIMITS.elements,
    MAX_DOCUMENT_POINT_BYTES,
  );
}
