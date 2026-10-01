import { expect, it, vi } from "vitest";
import { ChunkedInkbookInputParser } from "../../../src/persistence/serialization/chunked-input-codec";
import { StreamingSafeStaticValidator } from "../../../src/persistence/serialization/streaming-safe-static";
import { inspectTrustedSvgOutput } from "../../../src/persistence/scheduling/trusted-svg-output";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { matchVaultPreviewProof } from "../../../src/obsidian/embeds/vault-preview-proof";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";
import { createStandardPersistenceFixture } from "./fixtures";

it("reuses current preview validation with bounded complete-byte hashing and zero repeated static scans", async () => {
  const snapshot = createStandardPersistenceFixture();
  const serialized = serializeInkbookDocument(snapshot);
  if (!serialized.ok) throw new Error(serialized.error.code);
  const inspected = await inspectTrustedSvgOutput(serialized.value.svg);
  const bytes = new TextEncoder().encode(serialized.value.svg);
  const hashUpdate = vi.spyOn(ChunkedSha256.prototype, "update");
  const staticWrite = vi.spyOn(StreamingSafeStaticValidator.prototype, "write");
  const scheduler = { shouldYield: () => false, yieldControl: async () => {} };
  try {
    const proof = await matchVaultPreviewProof(bytes, () => inspected.safeStaticProof, scheduler);
    expect(proof).toBe(inspected.safeStaticProof);
    if (proof === undefined) throw new Error("Current complete preview proof was not matched.");
    const hashChunks = hashUpdate.mock.calls.map(([chunk]) => chunk.byteLength);
    expect(hashChunks.reduce((sum, size) => sum + size, 0)).toBe(bytes.byteLength);
    expect(Math.max(...hashChunks)).toBeLessThanOrEqual(64 * 1024);
    const parser = new ChunkedInkbookInputParser({
      staticValidation: "safe",
      safeStaticProof: proof,
    });
    await parser.write(bytes);
    const result = await parser.finish();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.snapshot.elements).toHaveLength(11_000);
    expect(staticWrite).not.toHaveBeenCalled();
    expect(parser.maximumRetainedStaticInputCharacters).toBe(0);
    hashUpdate.mockClear();
    const changed = bytes.slice();
    changed[changed.length - 1] = 0x20;
    expect(
      await matchVaultPreviewProof(changed, () => inspected.safeStaticProof, scheduler),
    ).toBeUndefined();
    expect(hashUpdate.mock.calls.reduce((sum, [chunk]) => sum + chunk.byteLength, 0)).toBe(
      bytes.byteLength,
    );
    const cold = new ChunkedInkbookInputParser({ staticValidation: "safe" });
    await cold.write(bytes);
    expect((await cold.finish()).ok).toBe(true);
    expect(staticWrite).toHaveBeenCalled();
  } finally {
    hashUpdate.mockRestore();
    staticWrite.mockRestore();
  }
}, 120_000);
