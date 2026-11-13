import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { invalidFont } from "./font-container";
import { decodeBrotliFont } from "./brotli-decoder";
import { readWoff2Directory } from "./woff2-directory";

export async function readWoff2MetadataTables(
  bytes: Uint8Array,
  limits: ReadonlyMap<string, number>,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const directory = readWoff2Directory(view);
  const retained = directory.tables
    .filter((table) => limits.has(table.tag))
    .map((table) => {
      if (table.decodedLength !== table.length || table.length > limits.get(table.tag)!)
        invalidFont();
      return { table, bytes: new Uint8Array(table.length) };
    });
  const input = bytes.subarray(
    directory.compressedOffset,
    directory.compressedOffset + directory.compressedBytes,
  );
  await decodeBrotliFont(input, directory.decodedBytes, {
    scheduler,
    ...(signal === undefined ? {} : { signal }),
    receive: (part, offset) => {
      for (const target of retained) {
        const start = Math.max(offset, target.table.decodedOffset);
        const end = Math.min(
          offset + part.length,
          target.table.decodedOffset + target.bytes.length,
        );
        if (end > start)
          target.bytes.set(
            part.subarray(start - offset, end - offset),
            start - target.table.decodedOffset,
          );
      }
    },
  });
  return new Map(retained.map((entry) => [entry.table.tag, entry.bytes]));
}
