const WEBP_IMAGES = {
  lossless: "UklGRhwAAABXRUJQVlA4TA8AAAAvAkAAAAcQ/Y/+ByKi/wEA",
  lossy:
    "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoDAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
  alpha:
    "UklGRmQAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAgIAAgIAAAFZQOCA2AAAAcAEAnQEqAwACAAFAJiWoAnQBQAAA/vtV4/8TH/t5l9gH7Ex/H//d5l9gH7Evu623/RXIAAAA",
} as const;

/** Real 3 x 2 ImageMagick/libwebp encodings: red, red, and partially transparent blue. */
export function webpBytes(kind: keyof typeof WEBP_IMAGES = "lossless") {
  return Uint8Array.from(atob(WEBP_IMAGES[kind]), (character) => character.charCodeAt(0));
}

/** Keep RIFF length and chunk padding valid while isolating a malformed header/chunk. */
export function webpContainer(...chunks: readonly Uint8Array[]) {
  const result = new Uint8Array(12 + chunks.reduce((size, chunk) => size + chunk.length, 0));
  const view = new DataView(result.buffer);
  result.set(new TextEncoder().encode("RIFF"));
  view.setUint32(4, result.length - 8, true);
  result.set(new TextEncoder().encode("WEBP"), 8);
  let offset = 12;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function webpChunk(kind: string, payload: Uint8Array = new Uint8Array()) {
  const chunk = new Uint8Array(8 + payload.length + (payload.length % 2));
  chunk.set(new TextEncoder().encode(kind));
  new DataView(chunk.buffer).setUint32(4, payload.length, true);
  chunk.set(payload, 8);
  return chunk;
}

export function extendedWebpHeader(width: number, height: number, flags = 0) {
  const payload = new Uint8Array(10);
  const view = new DataView(payload.buffer);
  payload[0] = flags;
  view.setUint32(4, width - 1, true);
  payload[7] = (height - 1) & 0xff;
  payload[8] = ((height - 1) >>> 8) & 0xff;
  payload[9] = ((height - 1) >>> 16) & 0xff;
  return webpChunk("VP8X", payload);
}
