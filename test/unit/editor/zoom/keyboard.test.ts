import { describe, expect, it } from "vitest";

import { keyboardZoomFactor, keyboardZoomStep } from "../../../../src/editor/zoom";

function shortcut(
  key: string,
  overrides: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {},
) {
  return {
    altKey: overrides.altKey ?? false,
    ctrlKey: overrides.ctrlKey ?? true,
    key,
    metaKey: overrides.metaKey ?? false,
  };
}

describe("keyboard zoom shortcuts", () => {
  it("maps platform plus and minus keys to exact zoom steps", () => {
    expect(keyboardZoomStep(shortcut("+"))).toBe(1);
    expect(keyboardZoomStep(shortcut("="))).toBe(1);
    expect(keyboardZoomStep(shortcut("Add"))).toBe(1);
    expect(keyboardZoomStep(shortcut("-", { ctrlKey: false, metaKey: true }))).toBe(-1);
    expect(keyboardZoomStep(shortcut("Subtract"))).toBe(-1);
    expect(keyboardZoomFactor(shortcut("+"))).toBe(1.08);
    expect(keyboardZoomFactor(shortcut("-"))).toBeCloseTo(1 / 1.08);
  });

  it("leaves unrelated and Alt-modified host shortcuts unclaimed", () => {
    expect(keyboardZoomStep(shortcut("+", { altKey: true }))).toBeUndefined();
    expect(keyboardZoomStep(shortcut("+", { ctrlKey: false }))).toBeUndefined();
    expect(keyboardZoomStep(shortcut("0"))).toBeUndefined();
  });
});
