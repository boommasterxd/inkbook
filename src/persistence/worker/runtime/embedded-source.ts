export interface EmbeddedSourceWindow {
  readonly Blob: new (blobParts?: BlobPart[], options?: BlobPropertyBag) => Blob;
  readonly DecompressionStream: typeof DecompressionStream;
  readonly Response: typeof Response;
}

const BASE91_ALPHABET =
  "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|}~";

export async function decodeEmbeddedSource(
  encoded: string,
  owningWindow: EmbeddedSourceWindow,
): Promise<string> {
  const compressed = decodeBase91(encoded);
  const stream = new owningWindow.Blob([compressed])
    .stream()
    .pipeThrough(new owningWindow.DecompressionStream("gzip"));
  return new owningWindow.Response(stream).text();
}

function decodeBase91(encoded: string): Uint8Array<ArrayBuffer> {
  const alphabetIndex = new Uint8Array(128).fill(255);
  for (let index = 0; index < BASE91_ALPHABET.length; index += 1) {
    alphabetIndex[BASE91_ALPHABET.charCodeAt(index)] = index;
  }
  const decoded = new Uint8Array(encoded.length);
  let buffer = 0;
  let bits = 0;
  let pending = -1;
  let written = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    const value = alphabetIndex[encoded.charCodeAt(index)];
    if (value === undefined || value === 255) throw new Error("Invalid embedded source encoding.");
    if (pending < 0) {
      pending = value;
      continue;
    }
    pending += value * 91;
    buffer |= pending << bits;
    bits += (pending & 8191) > 88 ? 13 : 14;
    while (bits > 7) {
      decoded[written] = buffer & 255;
      written += 1;
      buffer >>>= 8;
      bits -= 8;
    }
    pending = -1;
  }
  if (pending >= 0) {
    decoded[written] = (buffer | (pending << bits)) & 255;
    written += 1;
  }
  return decoded.subarray(0, written);
}

export function isEmbeddedSourceWindow(value: unknown): value is EmbeddedSourceWindow {
  return (
    typeof value === "object" &&
    value !== null &&
    "Blob" in value &&
    typeof value.Blob === "function" &&
    "DecompressionStream" in value &&
    typeof value.DecompressionStream === "function" &&
    "Response" in value &&
    typeof value.Response === "function"
  );
}
