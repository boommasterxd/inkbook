import { describe, expect, it } from "vitest";

import { sha256Bytes, sha256Utf8 } from "../../../src/domain/codecs/sha256";

const BYTE_128 = 128;
const BYTE_255 = 255;

describe("SHA-256 byte and UTF-8 boundaries", () => {
  it("matches established SHA-256 golden digests", async () => {
    await expect(sha256Utf8("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(sha256Utf8("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(
      sha256Bytes(new Uint8Array([0, BYTE_255, BYTE_128])),
    ).resolves.toBe(
      "f742b965f156c10374bc23aea96e3a8aff8facd6fc079defeaa30219ad86f211",
    );
  });

  it("hashes exact UTF-8 without Unicode, line-ending, whitespace, or BOM normalization", async () => {
    const variants = ["ä", "a\u0308", "line\n", "line\r\n", "abc", "\ufeffabc"];
    const digests = await Promise.all(variants.map(sha256Utf8));

    expect(new Set(digests).size).toBe(variants.length);
    await expect(sha256Utf8("\ufeffabc")).resolves.toBe(
      "1c28dc3f1f804a1ad9c9b4b4cf5e2658d16ad4ed08e3020d04a8d2865018947c",
    );
  });

  it("captures the named bytes before asynchronous hashing", async () => {
    const bytes = new Uint8Array([0, BYTE_255, BYTE_128]);
    const digest = sha256Bytes(bytes);
    bytes.fill(0);

    await expect(digest).resolves.toBe(
      "f742b965f156c10374bc23aea96e3a8aff8facd6fc079defeaa30219ad86f211",
    );
  });

  it("returns exactly 64 lowercase hexadecimal characters", async () => {
    await expect(sha256Utf8("ä😀\n")).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });
});
