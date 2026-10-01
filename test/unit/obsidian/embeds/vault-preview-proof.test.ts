import { describe, expect, it, vi } from "vitest";
import { matchVaultPreviewProof } from "../../../../src/obsidian/embeds/vault-preview-proof";
import { SafeStaticProof } from "../../../../src/persistence/serialization/safe-static-proof";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";
import type { StoreSliceScheduler } from "../../../../src/domain/store/public";

const bytes = new Uint8Array(128 * 1024 + 1).fill(0x61);
const hash = new ChunkedSha256();
hash.update(bytes);
const proof = SafeStaticProof.fromTrustedProducer(hash.digestHex(), bytes.byteLength);

function scheduler(): StoreSliceScheduler {
  return { shouldYield: () => false, yieldControl: vi.fn(async () => {}) };
}

describe("fresh Vault byte binding for safe preview reuse", () => {
  it("hashes every bounded input chunk before returning an owned proof", async () => {
    const update = vi.spyOn(ChunkedSha256.prototype, "update");
    const work = scheduler();
    try {
      expect(await matchVaultPreviewProof(bytes, () => proof, work)).toBe(proof);
      expect(update.mock.calls.map(([chunk]) => chunk.byteLength)).toEqual([65536, 65536, 1]);
      expect(work.yieldControl).not.toHaveBeenCalled();
    } finally {
      update.mockRestore();
    }
  });

  it("rejects changed bytes and missing or forged evidence", async () => {
    const changed = bytes.slice();
    changed[changed.length - 1] = 0x62;
    expect(await matchVaultPreviewProof(changed, () => proof, scheduler())).toBeUndefined();
    expect(
      await matchVaultPreviewProof(bytes.subarray(0, 1), () => proof, scheduler()),
    ).toBeUndefined();
    expect(await matchVaultPreviewProof(bytes, () => undefined, scheduler())).toBeUndefined();
    expect(
      await matchVaultPreviewProof(
        bytes,
        () => Object.create(SafeStaticProof.prototype) as SafeStaticProof,
        scheduler(),
      ),
    ).toBeUndefined();
  });

  it.each(["cancel", "release", "replace"])(
    "fails closed when ownership changes during a scheduler wait: %s",
    async (change) => {
      let current: SafeStaticProof | undefined = proof;
      let cancelled = false;
      let yielding = true;
      const work: StoreSliceScheduler = {
        shouldYield: () => yielding,
        isCancelled: () => cancelled,
        yieldControl: async () => {
          if (change === "cancel") cancelled = true;
          else
            current =
              change === "release"
                ? undefined
                : SafeStaticProof.fromTrustedProducer(proof.outputHash, proof.totalBytes);
          yielding = false;
        },
      };
      expect(await matchVaultPreviewProof(bytes, () => current, work)).toBeUndefined();
    },
  );
});
