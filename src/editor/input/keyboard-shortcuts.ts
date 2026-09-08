import {
  CONFIGURABLE_SHORTCUT_ACTIONS,
  canonicalShortcutBinding,
  canonicalShortcutKey,
  shortcutBindingSignature,
  type ConfigurableShortcutActionV1,
  type KeyboardShortcutBindingV1,
  type KeyboardShortcutSettingsV1,
  type ShortcutModifierV1,
} from "../../domain/settings/index";

const RESERVED_KEYS = new Set(["Escape", "Tab", "Enter", "ContextMenu", "F10"]);
const FIXED_SIGNATURES = new Set(["mod:v", "mod:z", "mod+shift:z", "shift:F10", ":Escape"]);

export interface ShortcutKeyboardInput {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export type ShortcutCaptureResult =
  | { readonly binding: KeyboardShortcutBindingV1; readonly kind: "accepted" }
  | { readonly kind: "ignored" }
  | { readonly kind: "reserved" };

export function resolveConfiguredShortcut(
  event: ShortcutKeyboardInput,
  shortcuts: KeyboardShortcutSettingsV1,
): ConfigurableShortcutActionV1 | undefined {
  return CONFIGURABLE_SHORTCUT_ACTIONS.find((action) => {
    const binding = shortcuts[action];
    return binding !== null && matchesShortcutBinding(event, binding, action);
  });
}

export function captureShortcutBinding(event: ShortcutKeyboardInput): ShortcutCaptureResult {
  if (isModifierKey(event.key)) return { kind: "ignored" };
  if (RESERVED_KEYS.has(event.key)) return { kind: "reserved" };
  const binding = canonicalShortcutBinding({
    key: event.key,
    modifiers: eventModifiers(event),
  });
  if (isUnsafeBarePrintable(binding) || FIXED_SIGNATURES.has(shortcutBindingSignature(binding))) {
    return { kind: "reserved" };
  }
  return { binding, kind: "accepted" };
}

function matchesShortcutBinding(
  event: ShortcutKeyboardInput,
  bindingValue: KeyboardShortcutBindingV1,
  action?: ConfigurableShortcutActionV1,
): boolean {
  const binding = canonicalShortcutBinding(bindingValue);
  if (!matchesKey(event.key, binding.key, action)) return false;
  const expected = new Set(binding.modifiers);
  const modActive = event.ctrlKey || event.metaKey;
  if (expected.has("mod")) {
    if (!modActive) return false;
  } else {
    if (expected.has("ctrl") !== event.ctrlKey) return false;
    if (expected.has("meta") !== event.metaKey) return false;
  }
  if (expected.has("alt") !== event.altKey) return false;
  return expected.has("shift") === event.shiftKey || shiftedPrintableKey(binding.key, event.key);
}

function matchesKey(
  eventKey: string,
  bindingKey: string,
  action: ConfigurableShortcutActionV1 | undefined,
): boolean {
  const actual = canonicalShortcutKey(eventKey);
  if (actual === bindingKey) return true;
  if (action === "zoom-in" && bindingKey === "+") return actual === "=" || actual === "Add";
  if (action === "zoom-out" && bindingKey === "-") return actual === "_" || actual === "Subtract";
  return false;
}

function eventModifiers(event: ShortcutKeyboardInput): ShortcutModifierV1[] {
  const modifiers: ShortcutModifierV1[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("mod");
  if (event.shiftKey) modifiers.push("shift");
  if (event.altKey) modifiers.push("alt");
  return modifiers;
}

function shiftedPrintableKey(bindingKey: string, eventKey: string): boolean {
  return bindingKey.length === 1 && eventKey === bindingKey && !/^[a-z0-9]$/i.test(bindingKey);
}

function isUnsafeBarePrintable(binding: KeyboardShortcutBindingV1): boolean {
  return binding.modifiers.length === 0 && binding.key.length === 1;
}

function isModifierKey(key: string): boolean {
  return (
    key === "Alt" || key === "AltGraph" || key === "Control" || key === "Meta" || key === "Shift"
  );
}
