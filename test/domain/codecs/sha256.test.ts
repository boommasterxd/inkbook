import { describe, expect, it } from "vitest";

import { sha256Bytes } from "../../../src/domain/codecs/sha256";

const BYTE_128 = 128;
const BYTE_255 = 255;

describe("SHA-256 byte boundaries", () => {
  it("matches established SHA-256 golden digests", async () => {
    await expect(sha256Bytes(new Uint8Array())).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(sha256Bytes(new TextEncoder().encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(
      sha256Bytes(new Uint8Array([0, BYTE_255, BYTE_128])),
    ).resolves.toBe(
      "f742b965f156c10374bc23aea96e3a8aff8facd6fc079defeaa30219ad86f211",
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
    await expect(
      sha256Bytes(new TextEncoder().encode("ä😀\n")),
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });
});
