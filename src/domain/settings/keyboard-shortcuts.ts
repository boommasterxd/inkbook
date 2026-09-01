import {
  CONFIGURABLE_SHORTCUT_ACTIONS,
  type ConfigurableShortcutActionV1,
  type KeyboardShortcutBindingV1,
  type KeyboardShortcutSettingsV1,
  type ShortcutModifierV1,
} from "./types";

const MODIFIER_ORDER: Readonly<Record<ShortcutModifierV1, number>> = Object.freeze({
  mod: 0,
  ctrl: 1,
  meta: 2,
  shift: 3,
  alt: 4,
});

export function createBuiltInKeyboardShortcuts(): KeyboardShortcutSettingsV1 {
  return {
    "select-all": binding("a", "mod"),
    copy: binding("c", "mod"),
    cut: binding("x", "mod"),
    "delete-selection": binding("Delete"),
    "zoom-in": binding("+", "mod"),
    "zoom-out": binding("-", "mod"),
    "bring-forward": binding("ArrowUp", "mod"),
    "send-backward": binding("ArrowDown", "mod"),
    "bring-to-front": binding("ArrowUp", "mod", "shift"),
    "send-to-back": binding("ArrowDown", "mod", "shift"),
  };
}

export function canonicalShortcutBinding(
  bindingValue: KeyboardShortcutBindingV1,
): KeyboardShortcutBindingV1 {
  const modifiers = [...new Set(bindingValue.modifiers)].sort(
    (left, right) => MODIFIER_ORDER[left] - MODIFIER_ORDER[right],
  );
  return { key: canonicalShortcutKey(bindingValue.key), modifiers };
}

export function shortcutBindingSignature(bindingValue: KeyboardShortcutBindingV1): string {
  const canonical = canonicalShortcutBinding(bindingValue);
  return `${canonical.modifiers.join("+")}:${canonical.key}`;
}

export function shortcutConflict(
  shortcuts: KeyboardShortcutSettingsV1,
  action: ConfigurableShortcutActionV1,
  candidate: KeyboardShortcutBindingV1,
): ConfigurableShortcutActionV1 | undefined {
  const signature = shortcutBindingSignature(candidate);
  return CONFIGURABLE_SHORTCUT_ACTIONS.find((other) => {
    const bindingValue = shortcuts[other];
    return (
      other !== action &&
      bindingValue !== null &&
      shortcutBindingSignature(bindingValue) === signature
    );
  });
}

export function canonicalShortcutKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function binding(key: string, ...modifiers: ShortcutModifierV1[]): KeyboardShortcutBindingV1 {
  return { key, modifiers };
}
