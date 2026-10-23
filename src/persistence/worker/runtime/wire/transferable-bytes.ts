import { isNativeArrayBuffer } from "../../../serialization/transfer-array";

export function exclusiveTransferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    isNativeArrayBuffer(bytes.buffer) &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(bytes);
}
