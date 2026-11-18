import { ChunkedInkbookInputParser } from "../../../serialization/input/chunked-input-codec";
import type { ValidatedSnapshotConsumer } from "../../../serialization/metadata/validated-snapshot-adoption";
import type { RuntimeSliceContext } from "../types";
import type { StrokeSampleEncodingCache } from "../../../serialization/metadata/stroke-sample-encoding-cache";
import { SafeStaticProof } from "../../../serialization/input/safe-static-proof";
import { hashConfirmedRuntimeInput } from "./runtime-input-hash";
import { isNativeArrayBuffer, isNativeUint8Array } from "../../../serialization/transfer-array";
import { MAX_NATIVE_HASH_BYTES } from "../../../serialization/output/chunked-output-assembler";
import { writeRuntimeInput } from "./runtime-input-writing";

export async function parseRuntimeInput(
  input: string | Uint8Array,
  context?: RuntimeSliceContext,
  onValidatedSnapshot?: ValidatedSnapshotConsumer,
  validation: "canonical" | "safe" | "worker-safe" = "canonical",
  sampleEncodingCache?: StrokeSampleEncodingCache,
  safeStaticProof?: SafeStaticProof,
) {
  const inputSliceBytes = context?.workProfile?.inputByteLimit ?? 256 * 1024;
  const inputWriteChunk = context?.workProfile?.inputByteLimit ?? 16 * 1024;
  const options = {
    ...(context === undefined ? {} : { checkpoint: context.checkpoint, signal: context.signal }),
    inputSliceBytes,
    staticValidation: validation === "worker-safe" ? ("safe" as const) : validation,
    ...(onValidatedSnapshot === undefined ? {} : { onValidatedSnapshot }),
    ...(sampleEncodingCache === undefined ? {} : { sampleEncodingCache }),
  };
  let matchingProof = safeStaticProof;
  if (
    validation === "worker-safe" &&
    SafeStaticProof.isAuthentic(safeStaticProof) &&
    isTransferredPreviewInput(input, safeStaticProof)
  ) {
    const parsed = await ChunkedInkbookInputParser.parseWorkerPreview(
      input,
      { ...options, safeStaticProof },
      inputWriteChunk,
    );
    if (parsed !== undefined) return parsed;
    matchingProof = undefined;
  } else if (validation !== "canonical") {
    matchingProof = await matchRuntimePreviewProof(input, safeStaticProof, context);
  }
  const parser = new ChunkedInkbookInputParser({
    ...options,
    ...(isNativeUint8Array(input) ? { nativeInputBytes: input.byteLength } : {}),
    ...(matchingProof === undefined ? {} : { safeStaticProof: matchingProof }),
  });
  await writeRuntimeInput(parser, input, inputWriteChunk);
  return parser.finish();
}

function isTransferredPreviewInput(
  input: string | Uint8Array,
  proof: SafeStaticProof,
): input is Uint8Array<ArrayBuffer> {
  return (
    isNativeUint8Array(input) &&
    isNativeArrayBuffer(input.buffer) &&
    input.byteOffset === 0 &&
    input.byteLength === input.buffer.byteLength &&
    input.byteLength === proof.totalBytes &&
    input.byteLength <= MAX_NATIVE_HASH_BYTES &&
    typeof crypto !== "undefined" &&
    crypto.subtle !== undefined
  );
}

/** A candidate may suppress the static scan only after hashing this executor's input. */
async function matchRuntimePreviewProof(
  input: string | Uint8Array,
  proof: SafeStaticProof | undefined,
  context?: RuntimeSliceContext,
): Promise<SafeStaticProof | undefined> {
  if (proof === undefined) return undefined;
  if (!SafeStaticProof.isAuthentic(proof)) {
    throw new TypeError("Safe SVG proof must come from an owned validation producer.");
  }
  if (isNativeUint8Array(input) && input.byteLength !== proof.totalBytes) return undefined;
  const hash = await hashConfirmedRuntimeInput(input, context, proof.totalBytes);
  context?.signal.throwIfAborted();
  return hash === proof.outputHash ? proof : undefined;
}
