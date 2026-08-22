import { ChunkedSha256 } from "./chunked-output-sha256";

export interface DocumentHashPort {
  hash(input: string | Uint8Array): string;
}

export const SHA256_DOCUMENT_HASHER: DocumentHashPort = Object.freeze({ hash: sha256Hex });

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const hash = new ChunkedSha256();
  hash.update(bytes);
  return hash.digestHex();
}
