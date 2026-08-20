import { sha256 } from "@noble/hashes/sha2.js";

const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return bytesToHex(sha256.create().update(bytes).digest());
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
  ).join("");
}
