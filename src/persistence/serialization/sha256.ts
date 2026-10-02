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

/** Hash exact UTF-8 text with at most 48 KiB of encoded scratch per scheduler checkpoint. */
export async function sha256TextChunked(
  input: string,
  checkpoint: () => Promise<void> | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const hash = new ChunkedSha256();
  const encoder = new TextEncoder();
  const scratch = new Uint8Array(48 * 1024);
  for (let offset = 0; offset < input.length;) {
    signal?.throwIfAborted();
    let end = Math.min(offset + 16 * 1024, input.length);
    const trailing = input.charCodeAt(end - 1);
    if (end < input.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
    const { read, written } = encoder.encodeInto(input.slice(offset, end), scratch);
    hash.update(scratch.subarray(0, written));
    offset += read;
    const pending = checkpoint();
    if (pending !== undefined) await pending;
  }
  signal?.throwIfAborted();
  return hash.digestHex();
}
