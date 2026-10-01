import { SafeStaticProof } from "../../serialization/safe-static-proof";
import { exclusiveTransferBytes } from "./transferable-bytes";
import type { UnlockRuntimeRequest, UnlockRuntimeBatch } from "./types";

export interface UnlockWireRequest extends Omit<UnlockRuntimeRequest, "safeStaticProof"> {
  readonly trustedSafeStatic?: { readonly outputHash: string; readonly totalBytes: number };
}

/** Only authentic host-owned evidence crosses the internal bundled-worker channel. */
export function encodeUnlockRequest(request: UnlockRuntimeRequest) {
  const { safeStaticProof, ...remaining } = request;
  if (safeStaticProof !== undefined && !SafeStaticProof.isAuthentic(safeStaticProof)) {
    throw new TypeError("Unlock proof is not owned safe SVG evidence.");
  }
  const input =
    request.input instanceof Uint8Array ? exclusiveTransferBytes(request.input) : request.input;
  const value: UnlockWireRequest = {
    ...remaining,
    input,
    ...(safeStaticProof === undefined
      ? {}
      : {
          trustedSafeStatic: {
            outputHash: safeStaticProof.outputHash,
            totalBytes: safeStaticProof.totalBytes,
          },
        }),
  };
  return { transfer: input instanceof Uint8Array ? [input.buffer] : [], value };
}

/** The owned worker channel is an internal producer, never a persisted-file codec. */
export function decodeUnlockRequest(request: UnlockWireRequest): UnlockRuntimeRequest {
  const { trustedSafeStatic, ...remaining } = request;
  if ("safeStaticProof" in request) throw new TypeError("Unlock wire proof is malformed.");
  return {
    ...remaining,
    ...(trustedSafeStatic === undefined
      ? {}
      : {
          safeStaticProof: SafeStaticProof.fromTrustedProducer(
            trustedSafeStatic.outputHash,
            trustedSafeStatic.totalBytes,
          ),
        }),
  };
}

export function isUnlockPurposeIdentity(value: unknown): value is UnlockRuntimeBatch["identity"] {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.sessionId === "string" &&
    typeof identity.workerEpoch === "number" &&
    Number.isSafeInteger(identity.workerEpoch) &&
    typeof identity.operationId === "number" &&
    Number.isSafeInteger(identity.operationId) &&
    (identity.purpose === "recovery" || identity.purpose === "unlock")
  );
}
