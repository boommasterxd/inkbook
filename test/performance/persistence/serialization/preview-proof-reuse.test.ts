import { expect, it, vi } from "vitest";
import { StreamingSafeStaticValidator } from "../../../../src/persistence/serialization/input/streaming-safe-static";
import { inspectTrustedSvgOutput } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { readVaultPreviewProofCandidate } from "../../../../src/obsidian/embeds/document-session/vault-preview-proof";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/model/document-model";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";
import { ChunkedInputHash } from "../../../../src/persistence/serialization/input/chunked-input-hash";
import { MAX_NATIVE_HASH_BYTES } from "../../../../src/persistence/serialization/output/chunked-output-assembler";
import { createStandardPersistenceFixture } from "../fixtures";

it("binds and parses one private worker input with one full digest and no repeated static scan", async () => {
  const snapshot = createStandardPersistenceFixture();
  const serialized = serializeInkbookDocument(snapshot);
  if (!serialized.ok) throw new Error(serialized.error.code);
  const inspected = await inspectTrustedSvgOutput(serialized.value.svg);
  const bytes = new TextEncoder().encode(serialized.value.svg);
  const hashUpdate = vi.spyOn(ChunkedSha256.prototype, "update");
  const digest = vi.spyOn(crypto.subtle, "digest");
  const release = vi.spyOn(ChunkedInputHash.prototype, "release");
  const staticWrite = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
  const set = vi.spyOn(Uint8Array.prototype, "set");
  const fullAllocations: ArrayBufferLike[] = [];
  vi.stubGlobal(
    "Uint8Array",
    new Proxy(Uint8Array, {
      construct(target, args: unknown[]) {
        const result = Reflect.construct(target, args) as Uint8Array;
        if (result.byteLength === bytes.byteLength && args[0] !== result.buffer)
          fullAllocations.push(result.buffer);
        return result;
      },
    }),
  );
  try {
    const proof = readVaultPreviewProofCandidate(bytes, () => inspected.safeStaticProof);
    expect(proof).toBe(inspected.safeStaticProof);
    if (proof === undefined) throw new Error("Current complete preview proof was not matched.");
    expect(hashUpdate).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    const worker = new DocumentModelRuntime(true);
    const result = await worker.unlock(bytes, undefined, undefined, proof);
    expect(result.snapshot.elements).toHaveLength(11_000);
    expect(result.outputHash).toBe(proof.outputHash);
    expect(staticWrite).not.toHaveBeenCalled();
    const freshByteChunks = hashUpdate.mock.calls
      .filter(([chunk]) => chunk.buffer === bytes.buffer)
      .map(([chunk]) => chunk.byteLength);
    expect(freshByteChunks).toHaveLength(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_NATIVE_HASH_BYTES);
    const completeDigests = digest.mock.calls
      .map(([, input]) => input as Uint8Array)
      .filter((input) => input.byteLength === bytes.byteLength);
    expect(completeDigests).toHaveLength(1);
    const confirmed = completeDigests[0]!;
    expect(confirmed.buffer).not.toBe(bytes.buffer);
    expect(fullAllocations).toEqual([confirmed.buffer]);
    const completeCopies = new Map<ArrayBufferLike, number>();
    set.mock.calls.forEach(([source], index) => {
      const target = set.mock.contexts[index] as Uint8Array;
      if (target.byteLength === bytes.byteLength) {
        completeCopies.set(target.buffer, (completeCopies.get(target.buffer) ?? 0) + source.length);
      }
    });
    expect([...completeCopies]).toEqual([[confirmed.buffer, bytes.byteLength]]);
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
    const parsed = await worker.unlock(changed, undefined, undefined, proof);
    expect(parsed.outputHash).not.toBe(proof.outputHash);
    expect(staticWrite).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    set.mockRestore();
    hashUpdate.mockRestore();
    digest.mockRestore();
    release.mockRestore();
    staticWrite.mockRestore();
  }
}, 120_000);
