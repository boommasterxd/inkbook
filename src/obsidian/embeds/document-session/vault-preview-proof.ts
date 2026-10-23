import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/public";
import { SafeStaticProof } from "../../../persistence/serialization/input/safe-static-proof";

/** Selects current evidence; the document executor must bind it to the fresh bytes. */
export function readVaultPreviewProofCandidate(
  bytes: Uint8Array,
  currentProof: () => SafeStaticProof | undefined,
): SafeStaticProof | undefined {
  const proof = currentProof();
  if (
    !SafeStaticProof.isAuthentic(proof) ||
    proof.totalBytes !== bytes.byteLength ||
    bytes.byteLength > FILE_SCHEMA_LIMITS.totalInputBytes
  )
    return undefined;
  return currentProof() === proof ? proof : undefined;
}
