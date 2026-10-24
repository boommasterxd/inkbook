import { describe, expect, it } from "vitest";

import { exactStringEqual } from "../../../../src/persistence/saving/exact-string-equality";

describe("exact string equality", () => {
  it("accepts equal large concatenated and decoded Unicode strings", () => {
    const value = "a".repeat(300_000) + "🖋️" + "b".repeat(300_000);
    const copy = new TextDecoder().decode(new TextEncoder().encode(value));

    expect(exactStringEqual(value, copy)).toBe(true);
  });

  it.each([0, 262_143, 262_144, 524_287, 599_999])(
    "rejects a mismatch at code-unit offset %i",
    (offset) => {
      const value = "a".repeat(600_000);
      const changed = `${value.slice(0, offset)}b${value.slice(offset + 1)}`;

      expect(exactStringEqual(value, changed)).toBe(false);
    },
  );

  it("compares isolated surrogate code units without replacing them", () => {
    const value = "🖋️\ud800x\udc00";
    const copy = ["🖋️", "\ud800", "x", "\udc00"].join("");

    expect(exactStringEqual(value, copy)).toBe(true);
    expect(exactStringEqual(value, "🖋️\ufffdx\udc00")).toBe(false);
    expect(exactStringEqual(value, "🖋️\ud800x\ufffd")).toBe(false);
  });

  it("handles empty strings and different lengths", () => {
    expect(exactStringEqual("", "")).toBe(true);
    expect(exactStringEqual("", "a")).toBe(false);
    expect(exactStringEqual("same", "same ")).toBe(false);
  });
});
