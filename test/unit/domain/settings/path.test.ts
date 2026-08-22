import { describe, expect, it } from "vitest";

import { validateCustomVaultFolderPath } from "../../../../src/domain/settings";

describe("custom vault folder paths", () => {
  it.each([
    ["Inkbook", "Inkbook"],
    [" Notes//Inkbook/./Drawings ", "Notes/Inkbook/Drawings"],
    ["Notes\\Inkbook", "Notes/Inkbook"],
  ])("normalizes %s", (input, expected) => {
    expect(validateCustomVaultFolderPath(input)).toEqual({ valid: true, path: expected });
  });

  it.each([
    ["", "empty"],
    ["./", "empty"],
    ["/Inkbook", "absolute"],
    ["C:/Inkbook", "absolute"],
    ["C:Inkbook", "absolute"],
    ["Notes/../Secrets", "traversal"],
    ["Notes\0Inkbook", "invalid-character"],
    ["a".repeat(256), "limit-exceeded"],
    ["😀".repeat(1025), "limit-exceeded"],
    [Array.from({ length: 129 }, () => "a").join("/"), "limit-exceeded"],
    [Array.from({ length: 65 }, () => "a").join("//"), "limit-exceeded"],
    [Array.from({ length: 129 }, () => ".").join("/"), "limit-exceeded"],
  ])("rejects %s", (input, error) => {
    expect(validateCustomVaultFolderPath(input)).toEqual({ valid: false, error });
  });

  it("accepts exact UTF-8, segment-byte, and segment-count boundaries", () => {
    const segments = Array.from({ length: 128 }, () => "é");
    segments[0] = "a".repeat(255);

    expect(validateCustomVaultFolderPath(segments.join("/")).valid).toBe(true);
    const exactPathBytes = [
      "a".repeat(240),
      ...Array.from({ length: 15 }, () => "a".repeat(239)),
      "a".repeat(255),
    ].join("/");
    expect(new TextEncoder().encode(exactPathBytes)).toHaveLength(4096);
    expect(validateCustomVaultFolderPath(exactPathBytes).valid).toBe(true);
  });
});
