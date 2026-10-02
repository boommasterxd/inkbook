import { describe, expect, it, vi } from "vitest";

import { sha256Hex, sha256TextChunked } from "../../../../src/persistence/serialization/sha256";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";

describe("document hashing", () => {
  it("hashes decoded Unicode text in bounded slices and cancels at checkpoints", async () => {
    const text = "x".repeat(16383) + "😀" + "ä".repeat(100000);
    const expected = sha256Hex(text);
    const update = vi.spyOn(ChunkedSha256.prototype, "update");
    try {
      const checkpoint = vi.fn(() => undefined);
      expect(await sha256TextChunked(text, checkpoint)).toBe(expected);
      expect(update.mock.calls.reduce((total, [bytes]) => total + bytes.byteLength, 0)).toBe(
        new TextEncoder().encode(text).byteLength,
      );
      expect(update.mock.calls.every(([bytes]) => bytes.byteLength <= 48 * 1024)).toBe(true);
      expect(checkpoint).toHaveBeenCalledTimes(update.mock.calls.length);
      const controller = new AbortController();
      update.mockClear();
      await expect(
        sha256TextChunked(
          text,
          () => {
            controller.abort();
            return undefined;
          },
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      update.mockRestore();
    }
  });

  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["Inkbook ä", "bf028fec80aaa561fbf8888ec9a96d7422adff967bb67903ccdf0b7d10e75b66"],
  ])("matches the SHA-256 vector for %j", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it("hashes strings and their UTF-8 byte representation identically", () => {
    const input = "portable SVG";
    expect(sha256Hex(input)).toBe(sha256Hex(new TextEncoder().encode(input)));
  });
});
