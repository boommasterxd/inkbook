import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkedInputHash } from "../../../../../src/persistence/serialization/input/chunked-input-hash";
import { SafeStaticProof } from "../../../../../src/persistence/serialization/input/safe-static-proof";
import { ChunkedSha256 } from "../../../../../src/persistence/serialization/chunked-output-sha256";
import { MAX_NATIVE_HASH_BYTES } from "../../../../../src/persistence/serialization/output/chunked-output-assembler";
import {
  sha256Hex,
  type DocumentHashPort,
} from "../../../../../src/persistence/serialization/sha256";

function options(bytes: number) {
  return {
    nativeExportHash: true,
    safeStaticProof: SafeStaticProof.fromTrustedProducer("a".repeat(64), bytes),
    staticValidation: "safe" as const,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("owned export input hashing", () => {
  it("digests exactly copied bytes and separates source mutation from consumed ownership", async () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const hash = new ChunkedInputHash(options(source.length));
    const first = hash.copy(source.subarray(0, 2))!;
    source.fill(9);
    const second = hash.copy(source.subarray(2))!;
    source.fill(7);
    expect(first.buffer).toBe(second.buffer);
    expect(first.buffer).not.toBe(source.buffer);
    expect([...first, ...second]).toEqual([1, 2, 9, 9]);
    await expect(hash.complete()).resolves.toBe(sha256Hex(new Uint8Array([1, 2, 9, 9])));
    expect(hash.retainedBytes).toBe(4);
    hash.release();
    expect(hash.retainedBytes).toBe(0);
  });

  it("uses the existing full JavaScript digest when native hashing fails", async () => {
    const source = new Uint8Array(128 * 1024).fill(17);
    const expected = sha256Hex(source);
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValue(new Error("Native unavailable"));
    const updates = vi.spyOn(ChunkedSha256.prototype, "update");
    const hash = new ChunkedInputHash(options(source.length));
    hash.copy(source);
    await expect(hash.complete()).resolves.toBe(expected);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls.reduce((total, [bytes]) => total + bytes.byteLength, 0)).toBe(
      source.length,
    );
    hash.release();
    expect(hash.retainedBytes).toBe(0);
  });

  it("never pads short input or accepts writes beyond the exact allocation", () => {
    const hash = new ChunkedInputHash(options(4));
    expect(hash.copy(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
    expect(hash.complete()).toBeUndefined();
    expect(hash.copy(new Uint8Array([3, 4, 5]))).toBeUndefined();
    expect(hash.retainedBytes).toBe(4);
    hash.release();
    expect(hash.retainedBytes).toBe(0);
  });

  it("caps allocation and keeps default and callback-driven parsers on incremental hashing", () => {
    const atLimit = new ChunkedInputHash(options(MAX_NATIVE_HASH_BYTES));
    expect(atLimit.retainedBytes).toBe(MAX_NATIVE_HASH_BYTES);
    atLimit.release();
    for (const config of [
      options(MAX_NATIVE_HASH_BYTES + 1),
      { ...options(4), nativeExportHash: false },
      { ...options(4), staticValidation: "canonical" as const },
      { ...options(4), onValidatedSnapshot: () => undefined },
      {},
    ]) {
      const hash = new ChunkedInputHash(config);
      expect(hash.retainedBytes).toBe(0);
      const source = new Uint8Array([1, 2, 3, 4]);
      const owned = hash.copy(source)!;
      hash.update(owned);
      expect(hash.complete()).toBe(sha256Hex(source));
      expect(hash.retainedBytes).toBe(0);
    }
  });

  it("does not allocate a collector when native crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    const hash = new ChunkedInputHash(options(4));
    const owned = hash.copy(new Uint8Array([1, 2, 3, 4]))!;
    hash.update(owned);
    expect(hash.complete()).toBe(sha256Hex(owned));
    expect(hash.retainedBytes).toBe(0);
  });
});

describe("legacy input hash ownership", () => {
  it("preserves constructor-captured custom hashers and their owned chunk sequence", () => {
    const original = vi.fn(sha256Hex);
    const config: { hasher: DocumentHashPort } = { hasher: { hash: original } };
    const hash = new ChunkedInputHash(config);
    const source = new Uint8Array([1, 2, 3, 4]);
    hash.copy(source.subarray(0, 2));
    hash.copy(source.subarray(2));
    source.fill(9);
    const forged = vi.fn(() => "forged");
    config.hasher = { hash: forged };
    expect(hash.beginWrite()).toBe(true);
    expect(hash.beginWrite()).toBe(true);
    expect(hash.retainedBytes).toBe(4);
    expect(hash.complete()).toBe(sha256Hex(new Uint8Array([1, 2, 3, 4])));
    expect(original).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3, 4]));
    expect(forged).not.toHaveBeenCalled();
    hash.release();
    expect(hash.retainedBytes).toBe(0);
  });
});
