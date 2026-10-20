import { describe, expect, it } from "vitest";

import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";

describe("chunked SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("matches official SHA-256 vector %#", (input, expected) => {
    expect(hashChunks([new TextEncoder().encode(input)])).toBe(expected);
  });

  it("matches the official million-a vector across arbitrary chunk boundaries", () => {
    const bytes = new TextEncoder().encode("a".repeat(1_000_000));
    expect(hashInPattern(bytes, [1, 7, 64, 65, 4093])).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("matches the platform reference for the standard 48.8 MB output size", async () => {
    const bytes = new Uint8Array(48_812_779);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

    expect(hashInPattern(bytes, [65_521, 262_144, 17])).toBe(await referenceHash(bytes));
  }, 15_000);

  it("keeps interleaved instances isolated and deterministic", async () => {
    const left = new ChunkedSha256();
    const right = new ChunkedSha256();
    left.update(new TextEncoder().encode("left-"));
    right.update(new TextEncoder().encode("right-"));
    left.update(new TextEncoder().encode("value"));
    right.update(new TextEncoder().encode("value"));

    expect(left.digestHex()).toBe(await referenceHash("left-value"));
    expect(right.digestHex()).toBe(await referenceHash("right-value"));
    expect(hashChunks([new TextEncoder().encode("left-value")])).toBe(left.digestHex());
  });

  it.each([
    { input: "", name: "empty input" },
    { input: "Inkbook ✒️", name: "UTF-8 input" },
    { input: "a".repeat(55), name: "one-block padding boundary" },
    { input: "a".repeat(56), name: "two-block padding boundary" },
    { input: "a".repeat(1_000), name: "multiple blocks" },
  ])("matches the platform reference across seven-byte chunks for $name", async ({ input }) => {
    const bytes = new TextEncoder().encode(input);
    const hash = new ChunkedSha256();
    for (let index = 0; index < bytes.length; index += 7) {
      hash.update(bytes.subarray(index, index + 7));
    }

    expect(hash.totalBytes).toBe(bytes.byteLength);
    expect(hash.digestHex()).toBe(await referenceHash(bytes));
  });

  it("rejects updates after finalization", () => {
    const hash = new ChunkedSha256();
    hash.digestHex();

    expect(() => hash.update(new Uint8Array([1]))).toThrow(
      "Cannot update a finalized SHA-256 digest.",
    );
  });
});

function hashInPattern(bytes: Uint8Array, sizes: readonly number[]): string {
  const chunks: Uint8Array[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; index += 1) {
    const end = Math.min(bytes.length, offset + sizes[index % sizes.length]!);
    chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  return hashChunks(chunks);
}

function hashChunks(chunks: readonly Uint8Array[]): string {
  const hash = new ChunkedSha256();
  for (const chunk of chunks) hash.update(chunk);
  return hash.digestHex();
}

async function referenceHash(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
