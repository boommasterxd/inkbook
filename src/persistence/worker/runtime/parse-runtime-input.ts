import type { InkSnapshotV1, SnapshotValidationDerivations } from "../../../domain/schema/public";
import { ChunkedInkbookInputParser } from "../../serialization/chunked-input-codec";
import type { PreparedPathObserver } from "../../serialization/prepared-unlock-paths";
import type { RuntimeSliceContext } from "./types";

export async function parseRuntimeInput(
  input: string | Uint8Array,
  context?: RuntimeSliceContext,
  onValidatedSnapshot?: (
    snapshot: InkSnapshotV1,
    derivations: SnapshotValidationDerivations,
  ) => Promise<void> | void,
  onPreparedPath?: PreparedPathObserver,
) {
  const inputSliceBytes = context?.workProfile?.inputByteLimit ?? 256 * 1024;
  const inputWriteChunk = context?.workProfile?.inputByteLimit ?? 16 * 1024;
  const parser = new ChunkedInkbookInputParser({
    ...(context === undefined ? {} : { checkpoint: context.checkpoint, signal: context.signal }),
    inputSliceBytes,
    ...(onPreparedPath === undefined ? {} : { onPreparedPath }),
    ...(onValidatedSnapshot === undefined ? {} : { onValidatedSnapshot }),
  });
  if (typeof input === "string") await writeStringInput(parser, input, inputWriteChunk);
  else await writeByteInput(parser, input, inputWriteChunk);
  return parser.finish();
}

async function writeByteInput(
  parser: ChunkedInkbookInputParser,
  input: Uint8Array,
  chunkBytes: number,
): Promise<void> {
  for (let offset = 0; offset < input.byteLength; offset += chunkBytes) {
    const written = await parser.write(input.subarray(offset, offset + chunkBytes));
    if (!written.ok) return;
  }
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
