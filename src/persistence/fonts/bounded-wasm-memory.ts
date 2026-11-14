/** Caps the sole internal memory of the pinned decoder before any Rust allocation. */
export function boundBrotliWasmMemory(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  if (bytes.length > 256 * 1024 || header.some((byte, index) => bytes[index] !== byte))
    unexpectedModule();
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const start = cursor.offset;
    const section = bytes[cursor.offset++];
    const length = readSectionLength(bytes, cursor);
    const end = cursor.offset + length;
    if (end > bytes.length) unexpectedModule();
    if (section === 5) {
      // brotli-dec-wasm 2.3.2: one memory, no maximum, nineteen initial 64-KiB pages.
      if (
        length !== 3 ||
        bytes[cursor.offset] !== 1 ||
        bytes[cursor.offset + 1] !== 0 ||
        bytes[cursor.offset + 2] !== 19
      )
        unexpectedModule();
      // The replacement section has a five-byte body; 1024 pages is unsigned LEB128 80 08.
      const bounded = new Uint8Array([5, 5, 1, 1, 19, 0x80, 0x08]);
      const output = new Uint8Array(bytes.length + bounded.length - (end - start));
      output.set(bytes.subarray(0, start));
      output.set(bounded, start);
      output.set(bytes.subarray(end), start + bounded.length);
      return output;
    }
    cursor.offset = end;
  }
  return unexpectedModule();
}

function readSectionLength(bytes: Uint8Array, cursor: { offset: number }): number {
  let length = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = bytes[cursor.offset++];
    if (byte === undefined) unexpectedModule();
    length += (byte & 127) * 2 ** (index * 7);
    if (length > 0xffffffff) unexpectedModule();
    if ((byte & 128) === 0) return length;
  }
  return unexpectedModule();
}

function unexpectedModule(): never {
  throw new Error("Unexpected Brotli decoder memory contract; review the pinned artifact.");
}
