import { expect, it, vi } from "vitest";
import { StreamingSafeStaticValidator } from "../../../../src/persistence/serialization/input/streaming-safe-static";
import { inspectTrustedSvgOutput } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { readVaultPreviewProofCandidate } from "../../../../src/obsidian/embeds/document-session/vault-preview-proof";
import { parseRuntimeInput } from "../../../../src/persistence/worker/runtime/model/parse-runtime-input";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";
import { ChunkedInputHash } from "../../../../src/persistence/serialization/input/chunked-input-hash";
import { MAX_NATIVE_HASH_BYTES } from "../../../../src/persistence/serialization/output/chunked-output-assembler";
import { createStandardPersistenceFixture } from "../fixtures";

it("moves complete preview-byte binding into the executor with zero host hashing and repeated static scans", async () => {
  const snapshot = createStandardPersistenceFixture();
  const serialized = serializeInkbookDocument(snapshot);
  if (!serialized.ok) throw new Error(serialized.error.code);
  const inspected = await inspectTrustedSvgOutput(serialized.value.svg);
  const bytes = new TextEncoder().encode(serialized.value.svg);
  const hashUpdate = vi.spyOn(ChunkedSha256.prototype, "update");
  const digest = vi.spyOn(crypto.subtle, "digest");
  const release = vi.spyOn(ChunkedInputHash.prototype, "release");
  const staticWrite = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
  try {
    const proof = readVaultPreviewProofCandidate(bytes, () => inspected.safeStaticProof);
    expect(proof).toBe(inspected.safeStaticProof);
    if (proof === undefined) throw new Error("Current complete preview proof was not matched.");
    expect(hashUpdate).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    const result = await parseRuntimeInput(bytes, undefined, undefined, "safe", undefined, proof);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.snapshot.elements).toHaveLength(11_000);
    expect(staticWrite).not.toHaveBeenCalled();
    const freshByteChunks = hashUpdate.mock.calls
      .filter(([chunk]) => chunk.buffer === bytes.buffer)
      .map(([chunk]) => chunk.byteLength);
    expect(freshByteChunks).toHaveLength(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_NATIVE_HASH_BYTES);
    const completeDigests = digest.mock.calls
      .map(([, input]) => input as Uint8Array)
      .filter((input) => input.byteLength === bytes.byteLength);
    expect(completeDigests).toHaveLength(2);
    expect(completeDigests[0]!.buffer).not.toBe(completeDigests[1]!.buffer);
    for (const input of completeDigests) {
      expect(input.buffer).not.toBe(bytes.buffer);
      expect(input).toEqual(bytes);
    }
    for (const owner of release.mock.contexts) expect(owner).toHaveProperty("retainedBytes", 0);
    const hashWork = new Map<unknown, number>();
    hashUpdate.mock.calls.forEach(([chunk], index) => {
      const owner = hashUpdate.mock.contexts[index];
      hashWork.set(owner, (hashWork.get(owner) ?? 0) + chunk.byteLength);
    });
    expect([...hashWork.values()].filter((size) => size === bytes.byteLength)).toHaveLength(0);
    hashUpdate.mockClear();
    const changed = new TextEncoder().encode(
      serialized.value.svg.replace(/ d="[^"]*"/u, (path) =>
        path.replace(/[0-9]/u, (digit) => (digit === "1" ? "2" : "1")),
      ),
    );
    expect(changed.byteLength).toBe(bytes.byteLength);
    expect(readVaultPreviewProofCandidate(changed, () => inspected.safeStaticProof)).toBe(proof);
    expect(hashUpdate).not.toHaveBeenCalled();
    expect(
      (await parseRuntimeInput(changed, undefined, undefined, "safe", undefined, proof)).ok,
    ).toBe(true);
    expect(staticWrite).toHaveBeenCalled();
  } finally {
    hashUpdate.mockRestore();
    digest.mockRestore();
    release.mockRestore();
    staticWrite.mockRestore();
  }
}, 120_000);
