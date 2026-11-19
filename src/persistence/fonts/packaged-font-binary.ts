import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { FONT_LIMITS, invalidFont } from "./font-container";
import { decodeFontResource } from "./font-resources";

const GZIP_HEADER = /^data:application\/gzip;length=([1-9]\d{0,7});base64,/;

/** Native builds compress each asset independently. Vite supplies the original asset as a data URL. */
export async function decodePackagedFontBinary(
  source: string,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const gzip = GZIP_HEADER.exec(source);
  if (gzip === null) {
    if (source.startsWith("data:application/gzip;")) invalidFont();
    const data = source.startsWith("data:") ? source.slice(source.indexOf(",") + 1) : source;
    return decodeFontResource({ data }, scheduler, signal);
  }
  const expectedBytes = Number(gzip[1]);
  if (expectedBytes > FONT_LIMITS.fileBytes) invalidFont();
  const data = source.slice(gzip[0].length);
  const bytes = await decodeFontResource({ data }, scheduler, signal);
  return inflateFontBinary(bytes, { format: "gzip", expectedBytes }, scheduler, signal);
}

export async function inflateFontBinary(
  source: Uint8Array<ArrayBuffer>,
  {
    format,
    expectedBytes,
  }: { readonly format: "gzip" | "deflate"; readonly expectedBytes: number },
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (expectedBytes > FONT_LIMITS.decodedBytes) invalidFont();
  const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      if (chunk.value.length > expectedBytes - offset) invalidFont();
      output.set(chunk.value, offset);
      offset += chunk.value.length;
      const pending = scheduler.checkpoint(signal, "background");
      if (pending !== undefined) await pending;
      signal?.throwIfAborted();
      chunk = await reader.read();
    }
    signal?.throwIfAborted();
    if (offset !== expectedBytes) invalidFont();
    return output;
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
