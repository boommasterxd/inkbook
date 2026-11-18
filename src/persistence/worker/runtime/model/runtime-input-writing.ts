import type { ChunkedInkbookInputParser } from "../../../serialization/input/chunked-input-codec";
import { writeInputByteChunks } from "../../../serialization/input/chunked-input-utils";

export async function writeRuntimeInput(
  parser: ChunkedInkbookInputParser,
  input: string | Uint8Array,
  chunkBytes: number,
): Promise<void> {
  if (typeof input === "string") await writeStringInput(parser, input, chunkBytes);
  else await writeInputByteChunks(parser, input, chunkBytes);
}

async function writeStringInput(
  parser: ChunkedInkbookInputParser,
  input: string,
  chunkCodeUnits: number,
): Promise<void> {
  const encoder = new TextEncoder();
  for (let offset = 0; offset < input.length;) {
    let end = Math.min(input.length, offset + chunkCodeUnits);
    const trailing = input.charCodeAt(end - 1);
    if (end < input.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
    const written = await parser.write(encoder.encode(input.slice(offset, end)));
    if (!written.ok) return;
    offset = end;
  }
}
