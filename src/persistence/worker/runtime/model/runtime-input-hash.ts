import { FILE_SCHEMA_LIMITS } from "../../../../domain/schema/public";
import { ChunkedSha256 } from "../../../serialization/chunked-output-sha256";
import type { RuntimeSliceContext } from "../types";
import { hashConfirmedSvgContent } from "../../../scheduling/trusted-svg-output";
import { MAX_NATIVE_HASH_BYTES } from "../../../serialization/output/chunked-output-assembler";
import { copyAndHashInputBytes } from "../../../serialization/input/chunked-input-hash";

/** Preflight and preview proofs digest bounded private copies inside the executor. */
export async function hashConfirmedRuntimeInput(
  input: string | Uint8Array,
  context?: RuntimeSliceContext,
  expectedBytes?: number,
): Promise<string | null> {
  if (!validExpectedBytes(expectedBytes) || input.length > FILE_SCHEMA_LIMITS.totalInputBytes)
    return null;
  if (typeof input !== "string") return hashConfirmedRuntimeBytes(input, context, expectedBytes);
  const options = {
    ...(context === undefined ? {} : { checkpoint: context.checkpoint, signal: context.signal }),
    chunkBytes: inputChunkSize(context),
  };
  return expectedBytes === undefined
    ? hashConfirmedSvgContent(input, options)
    : hashConfirmedSvgContent(input, { ...options, expectedBytes });
}

async function hashConfirmedRuntimeBytes(
  input: Uint8Array,
  context: RuntimeSliceContext | undefined,
  expectedBytes: number | undefined,
): Promise<string | null> {
  if (expectedBytes !== undefined && input.byteLength !== expectedBytes) return null;
  if (
    input.byteLength > MAX_NATIVE_HASH_BYTES ||
    typeof crypto === "undefined" ||
    crypto.subtle === undefined
  )
    return hashRuntimeInput(input, context, expectedBytes);
  const result = await copyAndHashInputBytes(input, context ?? {}, inputChunkSize(context));
  return result.hash;
}

export async function hashRuntimeInput(
  input: string | Uint8Array,
  context?: RuntimeSliceContext,
  expectedBytes?: number,
): Promise<string | null> {
  if (!validExpectedBytes(expectedBytes)) return null;
  if (input.length > FILE_SCHEMA_LIMITS.totalInputBytes) return null;
  const hash = new ChunkedSha256();
  const encoder = new TextEncoder();
  const chunkSize = inputChunkSize(context);
  for (let offset = 0; offset < input.length;) {
    context?.signal.throwIfAborted();
    let end = Math.min(offset + chunkSize, input.length);
    if (typeof input === "string") {
      const trailing = input.charCodeAt(end - 1);
      if (end < input.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
      hash.update(encoder.encode(input.slice(offset, end)));
    } else hash.update(input.subarray(offset, end));
    if (hash.totalBytes > FILE_SCHEMA_LIMITS.totalInputBytes) return null;
    offset = end;
    const pending = context?.checkpoint();
    if (pending !== undefined) await pending;
  }
  context?.signal.throwIfAborted();
  if (expectedBytes !== undefined && hash.totalBytes !== expectedBytes) return null;
  return hash.digestHex();
}

function inputChunkSize(context?: RuntimeSliceContext): number {
  const requested = context?.workProfile?.inputByteLimit ?? 64 * 1024;
  return Number.isSafeInteger(requested) && requested > 0
    ? Math.max(2, Math.min(requested, 64 * 1024))
    : 64 * 1024;
}

function validExpectedBytes(expectedBytes: number | undefined): boolean {
  return (
    expectedBytes === undefined ||
    (Number.isSafeInteger(expectedBytes) &&
      expectedBytes >= 0 &&
      expectedBytes <= FILE_SCHEMA_LIMITS.totalInputBytes)
  );
}
