import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { ChunkedSha256 } from "./chunked-output-sha256";
import { SampleBase64Writer } from "./metadata/sample-base64";
import { hashExactUtf8Output, MAX_NATIVE_HASH_BYTES } from "./output/chunked-output-assembler";

interface NativeBase64Array extends Uint8Array {
  toBase64?: () => string;
}

// Multiples of three keep intermediate Base64 chunks free of padding.
const NATIVE_CHUNK_BYTES = 48 * 1024;

/** Bind the exact portable payload and identity with bounded, centrally scheduled encoding. */
export async function encodeBinaryResource(
  bytes: Uint8Array,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<{ readonly id: string; readonly data: string }> {
  const native = (Uint8Array.prototype as NativeBase64Array).toBase64;
  if (typeof native === "function" && bytes.byteLength <= MAX_NATIVE_HASH_BYTES)
    return encodeNativeResource(bytes, native, scheduler, signal);
  return encodePortableResource(bytes, scheduler, signal);
}

async function encodeNativeResource(
  bytes: Uint8Array,
  encode: (this: Uint8Array) => string,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<{ readonly id: string; readonly data: string }> {
  const checkpoint = (): Promise<void> | undefined => scheduler.checkpoint(signal, "background");
  signal?.throwIfAborted();
  const ready = checkpoint();
  if (ready !== undefined) await ready;
  signal?.throwIfAborted();
  // Hashing may complete asynchronously; both outputs must share one private byte snapshot.
  const owned = new Uint8Array(bytes);
  const parts: string[] = [];
  for (let offset = 0; offset < owned.length; offset += NATIVE_CHUNK_BYTES) {
    parts.push(encode.call(owned.subarray(offset, offset + NATIVE_CHUNK_BYTES)));
    const pending = checkpoint();
    if (pending !== undefined) await pending;
    signal?.throwIfAborted();
  }
  const id = await hashExactUtf8Output(owned, signal, undefined, checkpoint);
  return { id, data: parts.join("") };
}

async function encodePortableResource(
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
