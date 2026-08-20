/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact byte and slice boundaries are the tested contract. */
import { describe, expect, it } from "vitest";

import {
  createPersistenceChunkPlanV1,
  createPersistenceCodecFallbackProcessorV1,
  createPersistenceEncodeWorkV1,
  createPersistenceParseWorkV1,
  normalizePersistenceCodecWorkV1,
  normalizePersistenceCodecWorkResultV1,
  PERSISTENCE_CODEC_CHUNK_UNITS_V1,
  PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
  PersistenceDecodedBytePoolV1,
  PersistenceElementChunkCacheV1,
  SIDECAR_RESOURCE_LIMITS_V1,
  SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1,
} from "../../../src/application/persistence";
import {
  decodeInkbookSidecarV1,
  encodeInkbookSidecarV1,
} from "../../../src/application/persistence/codec";
import { completeSidecar, executePersistenceCodecProcessor } from "./support";

describe("persistence codec wire work", () => {
  it("owns decoded bytes below and at the ceiling and rejects above it", () => {
    const pool = new PersistenceDecodedBytePoolV1();
    const below = pool.tryAcquire(PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1 - 1);
    expect(below?.byteLength).toBe(PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1 - 1);
    const boundaryRemainder = pool.tryAcquire(1);
    expect(boundaryRemainder?.byteLength).toBe(1);
    expect(pool.tryAcquire(1)).toBeNull();
    expect(() =>
      pool.tryAcquire(PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1 + 1),
    ).toThrow(RangeError);
    below?.release();
    below?.release();
    expect(pool.ownedBytes).toBe(1);
    boundaryRemainder?.release();
    const at = pool.tryAcquire(PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1);
    expect(at?.byteLength).toBe(PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1);
    at?.release();
    expect(pool.ownedBytes).toBe(0);
  });

  it("plans bounded zero-copy ranges below, at, and above one chunk", () => {
    expect(createPersistenceChunkPlanV1(0, 1)).toEqual([]);
    expect(
      createPersistenceChunkPlanV1(
        PERSISTENCE_CODEC_CHUNK_UNITS_V1,
        PERSISTENCE_CODEC_CHUNK_UNITS_V1 + 1,
      ),
    ).toEqual([{ offset: 0, length: PERSISTENCE_CODEC_CHUNK_UNITS_V1 }]);
    expect(
      createPersistenceChunkPlanV1(
        PERSISTENCE_CODEC_CHUNK_UNITS_V1 + 1,
        PERSISTENCE_CODEC_CHUNK_UNITS_V1 + 1,
      ),
    ).toEqual([
      { offset: 0, length: PERSISTENCE_CODEC_CHUNK_UNITS_V1 },
      { offset: PERSISTENCE_CODEC_CHUNK_UNITS_V1, length: 1 },
    ]);
    expect(() => createPersistenceChunkPlanV1(2, 1)).toThrow(RangeError);
  });

  it("rejects an over-ceiling worker DTO before touching its sidecar model", () => {
    let sidecarRead = false;
    const work = {
      wireVersion: 1,
      kind: "encode-sidecar",
      writableTier: "phone",
      admittedDecodedBytes: PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1 + 1,
      affectedElementIds: [],
      get sidecar(): never {
        sidecarRead = true;
        throw new Error("Sidecar should not be read.");
      },
    };

    expect(() => normalizePersistenceCodecWorkV1(work)).toThrow(RangeError);
    expect(sidecarRead).toBe(false);
  });
});

describe("persistence canonical codec work", () => {
  it("delegates canonical encoding exactly once to the existing codec authority", () => {
    const sidecar = completeSidecar();
    const owner = new PersistenceDecodedBytePoolV1().tryAcquire(1);
    if (owner === null) throw new Error("Test admission failed.");
    const result = executePersistenceCodecProcessor(
      createPersistenceEncodeWorkV1(
        sidecar,
        "phone",
        owner,
        SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1.phone,
      ),
    );

    expect(result.kind).toBe("encoded-sidecar");
    if (result.kind !== "encoded-sidecar") return;
    expect(result.bytes).toEqual(encodeInkbookSidecarV1(sidecar, "phone"));
    expect(result.byteChunks.at(-1)?.offset).toBeTypeOf("number");
    expect(result.byteChunks.at(-1)?.length).toBeTypeOf("number");
    expect(normalizePersistenceCodecWorkResultV1(result)).toEqual(result);
    expect(() =>
      normalizePersistenceCodecWorkResultV1({
        ...result,
        bytes: result.bytes.subarray(1),
      }),
    ).toThrow("must own one complete ArrayBuffer");
  });

  it("reuses unchanged canonical element chunks on a warm affected-only save", () => {
    const sidecar = completeSidecar();
    const owner = new PersistenceDecodedBytePoolV1().tryAcquire(1);
    if (owner === null) throw new Error("Test admission failed.");
    const cache = new PersistenceElementChunkCacheV1();
    const cold = executePersistenceCodecProcessor(
      createPersistenceEncodeWorkV1(
        sidecar,
        "phone",
        owner,
        SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1.phone,
      ),
      cache,
    );
    const affected = sidecar.scene.elements[0]?.elementId;
    if (cold.kind !== "encoded-sidecar" || affected === undefined) {
      throw new Error("Cold encode failed.");
    }
    const warm = executePersistenceCodecProcessor(
      createPersistenceEncodeWorkV1(
        sidecar,
        "phone",
        owner,
        SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1.phone,
        [affected],
      ),
      cache,
    );
    if (warm.kind !== "encoded-sidecar") throw new Error("Warm encode failed.");

    expect(cold.encodedElementCount).toBe(sidecar.scene.elements.length);
    expect(warm.encodedElementCount).toBe(1);
    expect(warm.reusedElementCount).toBe(sidecar.scene.elements.length - 1);
    expect(warm.bytes).toEqual(encodeInkbookSidecarV1(sidecar, "phone"));
  });

  it("passes raw Vault text to the bounded parser without main-thread pre-parsing", () => {
    const encoded = encodeInkbookSidecarV1(completeSidecar(), "phone");
    const rawText = new TextDecoder().decode(encoded);
    const pool = new PersistenceDecodedBytePoolV1();
    const owner = pool.tryAcquire(1);
    if (owner === null) throw new Error("Test admission failed.");
    const result = executePersistenceCodecProcessor(
      createPersistenceParseWorkV1(rawText, encoded.byteLength, owner),
    );

    expect(result).toEqual({
      wireVersion: 1,
      kind: "parsed-sidecar",
      value: decodeInkbookSidecarV1(rawText),
    });
    expect(normalizePersistenceCodecWorkResultV1(result)).toEqual(result);
    expect(() =>
      createPersistenceParseWorkV1(
        "{}",
        SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes + 1,
        owner,
      ),
    ).toThrow(RangeError);
    owner.release();
    expect(() => createPersistenceParseWorkV1("{}", 2, owner)).toThrow(
      "Decoded memory admission was already released.",
    );
  });
});

describe("persistence fallback slices", () => {
  it("rejects an over-wide sidecar object in the shared fallback parser", () => {
    const canonical = new TextDecoder().decode(
      encodeInkbookSidecarV1(completeSidecar(), "phone"),
    );
    const excessMembers = Array.from(
      { length: SIDECAR_RESOURCE_LIMITS_V1.maxObjectMembersPerObject + 1 },
      (_, index) => `"extra-${String(index)}":0`,
    ).join(",");
    const rawText = `{${excessMembers},${canonical.slice(1)}`;
    const fallback = createPersistenceCodecFallbackProcessorV1(
      createPersistenceParseWorkV1(
        rawText,
        new TextEncoder().encode(rawText).byteLength,
        rawText.length * 2,
      ),
    );

    expect(() => {
      while (!fallback.processNext()) {
        // Drive the same bounded processor used by worker and main fallback.
      }
    }).toThrow("object-member-limit");
    expect(() => fallback.complete()).toThrow("incomplete");
    fallback.dispose();
  });

  it("incrementally parses bounded text without work in complete", () => {
    const encoded = encodeInkbookSidecarV1(completeSidecar(), "phone");
    const rawText = `${" ".repeat(PERSISTENCE_CODEC_CHUNK_UNITS_V1 * 2)}${new TextDecoder().decode(encoded)}`;
    const work = createPersistenceParseWorkV1(
      rawText,
      new TextEncoder().encode(rawText).byteLength,
      rawText.length * 2,
    );
    const fallback = createPersistenceCodecFallbackProcessorV1(work);
    let steps = 0;

    expect(() => fallback.complete()).toThrow("incomplete");
    while (!fallback.processNext()) steps += 1;
    const result = fallback.complete();

    expect(steps).toBeGreaterThan(2);
    expect(result).toEqual({
      wireVersion: 1,
      kind: "parsed-sidecar",
      value: decodeInkbookSidecarV1(rawText),
    });
    expect(fallback.complete()).toBe(result);
  });
});
