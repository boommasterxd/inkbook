import { describe, expect, it } from "vitest";

import {
  captureShortcutBinding,
  resolveConfiguredShortcut,
  type ShortcutKeyboardInput,
} from "../../../../src/editor/input/keyboard-shortcuts";
import { createBuiltInKeyboardShortcuts } from "../../../../src/domain/settings";

function input(
  key: string,
  modifiers: Partial<Omit<ShortcutKeyboardInput, "key">> = {},
): ShortcutKeyboardInput {
  return {
    altKey: false,
    ctrlKey: false,
    key,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

describe("configured keyboard shortcuts", () => {
  it("resolves built-in canvas actions on Ctrl and Meta", () => {
    const shortcuts = createBuiltInKeyboardShortcuts();

    expect(resolveConfiguredShortcut(input("a", { ctrlKey: true }), shortcuts)).toBe("select-all");
    expect(resolveConfiguredShortcut(input("C", { metaKey: true }), shortcuts)).toBe("copy");
    expect(resolveConfiguredShortcut(input("ArrowUp", { ctrlKey: true }), shortcuts)).toBe(
      "bring-forward",
    );
    expect(
      resolveConfiguredShortcut(input("ArrowUp", { ctrlKey: true, shiftKey: true }), shortcuts),
    ).toBe("bring-to-front");
  });

  it("supports keyboard-layout zoom aliases without accepting extra modifiers", () => {
    const shortcuts = createBuiltInKeyboardShortcuts();

    expect(resolveConfiguredShortcut(input("=", { ctrlKey: true }), shortcuts)).toBe("zoom-in");
    expect(
      resolveConfiguredShortcut(input("+", { ctrlKey: true, shiftKey: true }), shortcuts),
    ).toBe("zoom-in");
    expect(resolveConfiguredShortcut(input("Subtract", { metaKey: true }), shortcuts)).toBe(
      "zoom-out",
    );
    expect(resolveConfiguredShortcut(input("-", { altKey: true, ctrlKey: true }), shortcuts)).toBe(
      undefined,
    );
  });

  it("does not resolve cleared actions", () => {
    const shortcuts = { ...createBuiltInKeyboardShortcuts(), copy: null };

    expect(resolveConfiguredShortcut(input("c", { ctrlKey: true }), shortcuts)).toBeUndefined();
  });
});

describe("shortcut recording", () => {
  it("normalizes modifier order and platform Mod", () => {
    expect(
      captureShortcutBinding(input("K", { altKey: true, ctrlKey: true, shiftKey: true })),
    ).toEqual({
      binding: { key: "k", modifiers: ["mod", "shift", "alt"] },
      kind: "accepted",
    });
  });

  it.each([
    input("Escape"),
    input("ContextMenu"),
    input("F10", { shiftKey: true }),
    input("v", { ctrlKey: true }),
    input("z", { metaKey: true }),
    input("z", { ctrlKey: true, shiftKey: true }),
    input("q"),
  ])("rejects fixed, accessible, or unsafe binding %#", (event) => {
    expect(captureShortcutBinding(event)).toEqual({ kind: "reserved" });
  });

  it("ignores a modifier-only event until the actual key arrives", () => {
    expect(captureShortcutBinding(input("Control", { ctrlKey: true }))).toEqual({
      kind: "ignored",
    });
  });

  it("matches explicit Ctrl and Meta bindings without conflating them", () => {
    const shortcuts = {
      ...createBuiltInKeyboardShortcuts(),
      copy: { key: "k", modifiers: ["ctrl"] },
    } as const;

    expect(resolveConfiguredShortcut(input("k", { ctrlKey: true }), shortcuts)).toBe("copy");
    expect(resolveConfiguredShortcut(input("k", { metaKey: true }), shortcuts)).toBeUndefined();
  });
});
