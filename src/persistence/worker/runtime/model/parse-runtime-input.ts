import { ChunkedInkbookInputParser } from "../../../serialization/input/chunked-input-codec";
import type { ValidatedSnapshotConsumer } from "../../../serialization/metadata/validated-snapshot-adoption";
import type { RuntimeSliceContext } from "../types";
import type { StrokeSampleEncodingCache } from "../../../serialization/metadata/stroke-sample-encoding-cache";
import { SafeStaticProof } from "../../../serialization/input/safe-static-proof";
import { hashRuntimeInput } from "./runtime-input-hash";
import { isNativeUint8Array } from "../../../serialization/transfer-array";
import { writeRuntimeInput } from "./runtime-input-writing";

export async function parseRuntimeInput(
  input: string | Uint8Array,
  context?: RuntimeSliceContext,
  onValidatedSnapshot?: ValidatedSnapshotConsumer,
  staticValidation: "canonical" | "safe" = "canonical",
  sampleEncodingCache?: StrokeSampleEncodingCache,
  safeStaticProof?: SafeStaticProof,
) {
  const matchingProof =
    staticValidation === "safe"
      ? await matchRuntimePreviewProof(input, safeStaticProof, context)
      : safeStaticProof;
  const inputSliceBytes = context?.workProfile?.inputByteLimit ?? 256 * 1024;
  const inputWriteChunk = context?.workProfile?.inputByteLimit ?? 16 * 1024;
  const parser = new ChunkedInkbookInputParser({
    ...(context === undefined ? {} : { checkpoint: context.checkpoint, signal: context.signal }),
    inputSliceBytes,
    staticValidation,
    ...(onValidatedSnapshot === undefined ? {} : { onValidatedSnapshot }),
    ...(sampleEncodingCache === undefined ? {} : { sampleEncodingCache }),
    ...(matchingProof === undefined ? {} : { safeStaticProof: matchingProof }),
  });
  await writeRuntimeInput(parser, input, inputWriteChunk);
  return parser.finish();
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
  const hash = await hashRuntimeInput(input, context, proof.totalBytes);
  context?.signal.throwIfAborted();
  return hash === proof.outputHash ? proof : undefined;
}
