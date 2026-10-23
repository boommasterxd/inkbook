const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!;
const typedArrayName = Object.getOwnPropertyDescriptor(
  Reflect.getPrototypeOf(Uint8Array.prototype)!,
  Symbol.toStringTag,
)!;

/** Native brands remain valid when the owning worker window is another realm. */
export function isNativeArrayBuffer(value: unknown): value is ArrayBuffer {
  try {
    arrayBufferByteLength.get!.call(value);
    return true;
  } catch {
    return false;
  }
}

export function isNativeFloat64Array(value: unknown): value is Float64Array {
  return ArrayBuffer.isView(value) && typedArrayName.get!.call(value) === "Float64Array";
}

export function isNativeUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && typedArrayName.get!.call(value) === "Uint8Array";
}

/** Rehomes the view for domain consumers without copying its transferred samples. */
export function adoptLocalStrokeArray(points: Float64Array): Float64Array {
  const { buffer, byteOffset, length } = points;
  return points instanceof Float64Array ? points : new Float64Array(buffer, byteOffset, length);
}
