const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
  ).join("");
}

export function sha256Utf8(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text));
}
