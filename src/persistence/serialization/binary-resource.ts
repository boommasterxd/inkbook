import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { ChunkedSha256 } from "./chunked-output-sha256";
import { SampleBase64Writer } from "./metadata/sample-base64";

/** Bind the exact portable payload and its identity in one centrally scheduled byte pass. */
export async function encodeBinaryResource(
  bytes: Uint8Array,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<{ readonly id: string; readonly data: string }> {
  const writer = new SampleBase64Writer();
  const hash = new ChunkedSha256();
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    signal?.throwIfAborted();
    const part = bytes.subarray(offset, offset + 4096);
    hash.update(part);
    for (const byte of part) writer.append(byte);
    const pending = scheduler.checkpoint(signal, "background");
    if (pending !== undefined) await pending;
    signal?.throwIfAborted();
  }
  return { id: hash.digestHex(), data: writer.finish() };
}
