import { ChunkedInkbookInputParser } from "../../../serialization/input/chunked-input-codec";
import { SafeStaticProof } from "../../../serialization/input/safe-static-proof";
import type { PrepareExportGeometryRequest, RuntimeSliceContext } from "../types";
import { parseRuntimeInput } from "./parse-runtime-input";
import { writeRuntimeInput } from "./runtime-input-writing";

/** Export publishes no snapshot callbacks; finish authenticates the complete consumed bytes. */
export async function parseExportGeometryInput(
  request: PrepareExportGeometryRequest,
  context?: RuntimeSliceContext,
) {
  const { input, safeStaticProof } = request;
  if (safeStaticProof !== undefined && !SafeStaticProof.isAuthentic(safeStaticProof)) {
    throw new TypeError("Safe SVG proof must come from an owned validation producer.");
  }
  if (
    safeStaticProof === undefined ||
    (typeof input !== "string" && input.byteLength !== safeStaticProof.totalBytes)
  ) {
    return parseRuntimeInput(input, context, undefined, "safe");
  }
  const parsed = await parseCandidateInput(input, safeStaticProof, context);
  context?.signal.throwIfAborted();
  // A stale proof must retain the ordinary complete safe-envelope validation fallback.
  return parsed.ok ? parsed : parseRuntimeInput(input, context, undefined, "safe");
}

/** End this parser's ownership before a stale candidate starts a separate validation. */
async function parseCandidateInput(
  input: string | Uint8Array,
  safeStaticProof: SafeStaticProof,
  context?: RuntimeSliceContext,
) {
  const parser = new ChunkedInkbookInputParser({
    ...(context === undefined ? {} : { checkpoint: context.checkpoint, signal: context.signal }),
    inputSliceBytes: context?.workProfile?.inputByteLimit ?? 256 * 1024,
    nativeExportHash: typeof input !== "string",
    safeStaticProof,
    staticValidation: "safe",
  });
  await writeRuntimeInput(parser, input, context?.workProfile?.inputByteLimit ?? 16 * 1024);
  return parser.finish();
}
