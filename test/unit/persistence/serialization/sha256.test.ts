import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../../../src/persistence/serialization/sha256";

describe("document hashing", () => {
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
