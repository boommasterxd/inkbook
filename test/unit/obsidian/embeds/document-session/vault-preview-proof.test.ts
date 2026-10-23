import { describe, expect, it, vi } from "vitest";
import { readVaultPreviewProofCandidate } from "../../../../../src/obsidian/embeds/document-session/vault-preview-proof";
import { SafeStaticProof } from "../../../../../src/persistence/serialization/input/safe-static-proof";
import { ChunkedSha256 } from "../../../../../src/persistence/serialization/chunked-output-sha256";

const bytes = new Uint8Array(128 * 1024 + 1).fill(0x61);
const hash = new ChunkedSha256();
hash.update(bytes);
const proof = SafeStaticProof.fromTrustedProducer(hash.digestHex(), bytes.byteLength);

describe("current Vault preview proof candidate selection", () => {
  it("selects current evidence without hashing on the host", () => {
    const update = vi.spyOn(ChunkedSha256.prototype, "update");
    try {
      expect(readVaultPreviewProofCandidate(bytes, () => proof)).toBe(proof);
      expect(update).not.toHaveBeenCalled();
    } finally {
      update.mockRestore();
    }
  });

  it("leaves same-size byte changes to the executor and rejects missing or forged evidence", () => {
    const changed = bytes.slice();
    changed[changed.length - 1] = 0x62;
    expect(readVaultPreviewProofCandidate(changed, () => proof)).toBe(proof);
    expect(readVaultPreviewProofCandidate(bytes.subarray(0, 1), () => proof)).toBeUndefined();
    expect(readVaultPreviewProofCandidate(bytes, () => undefined)).toBeUndefined();
    expect(
      readVaultPreviewProofCandidate(
        bytes,
        () => Object.create(SafeStaticProof.prototype) as SafeStaticProof,
      ),
    ).toBeUndefined();
  });

  it.each(["release", "replace"])(
    "rejects evidence whose current ownership changes during selection: %s",
    (change) => {
      const replacement =
        change === "release"
          ? undefined
          : SafeStaticProof.fromTrustedProducer(proof.outputHash, proof.totalBytes);
      const current = vi.fn().mockReturnValueOnce(proof).mockReturnValueOnce(replacement);
      expect(readVaultPreviewProofCandidate(bytes, current)).toBeUndefined();
    },
  );
});
