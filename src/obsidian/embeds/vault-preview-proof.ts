import type { StoreSliceScheduler } from "../../domain/store/public";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import { ChunkedSha256 } from "../../persistence/serialization/chunked-output-sha256";
import { SafeStaticProof } from "../../persistence/serialization/safe-static-proof";

/** Hashes newly read Vault bytes before permitting any preview validation reuse. */
export async function matchVaultPreviewProof(
  bytes: Uint8Array,
  currentProof: () => SafeStaticProof | undefined,
  scheduler: StoreSliceScheduler,
): Promise<SafeStaticProof | undefined> {
  const proof = currentProof();
  if (
    !SafeStaticProof.isAuthentic(proof) ||
    proof.totalBytes !== bytes.byteLength ||
    bytes.byteLength > FILE_SCHEMA_LIMITS.totalInputBytes
  )
    return undefined;
  const hasher = new ChunkedSha256();
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
    if (scheduler.isCancelled?.()) return undefined;
    hasher.update(bytes.subarray(offset, offset + 64 * 1024));
    if (scheduler.shouldYield()) await scheduler.yieldControl();
  }
  if (scheduler.isCancelled?.() || currentProof() !== proof) return undefined;
  return proof.matches(hasher.digestHex(), bytes.byteLength) ? proof : undefined;
}
