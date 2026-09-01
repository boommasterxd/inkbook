import { describe, expect, it } from "vitest";

import {
  canonicalShortcutBinding,
  createBuiltInKeyboardShortcuts,
  shortcutBindingSignature,
  shortcutConflict,
} from "../../../../src/domain/settings";

describe("keyboard shortcut settings", () => {
  it("creates independent built-in maps", () => {
    const first = createBuiltInKeyboardShortcuts();
    const second = createBuiltInKeyboardShortcuts();

    expect(first).not.toBe(second);
    expect(first.copy).not.toBe(second.copy);
    expect(second.copy).toEqual({ key: "c", modifiers: ["mod"] });
  });

  it("canonicalizes keys, duplicate modifiers, and modifier order", () => {
    expect(
      canonicalShortcutBinding({ key: "K", modifiers: ["alt", "mod", "shift", "mod"] }),
    ).toEqual({ key: "k", modifiers: ["mod", "shift", "alt"] });
    expect(shortcutBindingSignature({ key: "K", modifiers: ["shift", "mod"] })).toBe("mod+shift:k");
  });

  it("reports only a conflicting different action", () => {
    const shortcuts = createBuiltInKeyboardShortcuts();

    expect(shortcutConflict(shortcuts, "cut", { key: "c", modifiers: ["mod"] })).toBe("copy");
    expect(shortcutConflict(shortcuts, "copy", { key: "c", modifiers: ["mod"] })).toBeUndefined();
  });
});
