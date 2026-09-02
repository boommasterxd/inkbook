import { Platform } from "obsidian";

import type { KeyboardShortcutBindingV1 } from "../../domain/settings";
import type { ObsidianHotkeyBinding } from "./obsidian-hotkey-conflicts";

export function renderShortcutBinding(
  container: HTMLElement,
  binding: KeyboardShortcutBindingV1 | null,
): void {
  container.replaceChildren();
  if (binding === null) {
    container.createSpan({ cls: "inkbook-shortcut-unassigned", text: "Not assigned" });
    return;
  }
  renderShortcutKeyGroups(container, [bindingParts(binding)]);
}

export function renderReadOnlyShortcutBinding(
  container: HTMLElement,
  groups: readonly (readonly string[])[],
): void {
  if (groups.length === 0) {
    container.createSpan({ cls: "inkbook-shortcut-unassigned", text: "Not assigned" });
    return;
  }
  renderShortcutKeyGroups(container, groups);
}

export function obsidianHotkeyParts(binding: ObsidianHotkeyBinding): readonly string[] {
  return [...binding.modifiers, binding.key];
}

function renderShortcutKeyGroups(
  container: HTMLElement,
  groups: readonly (readonly string[])[],
): void {
  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) container.createSpan({ cls: "inkbook-shortcut-alternative", text: "or" });
    for (const part of group) container.createEl("kbd", { text: fixedKeyLabel(part) });
  });
}

function fixedKeyLabel(part: string): string {
  return part === "Mod" ? (Platform.isMacOS ? "⌘" : "Ctrl") : part;
}

function bindingParts(binding: KeyboardShortcutBindingV1): readonly string[] {
  const modifiers = binding.modifiers.map((modifier) => {
    if (modifier === "mod") return Platform.isMacOS ? "⌘" : "Ctrl";
    if (modifier === "meta") return "Meta";
    return modifier[0]?.toUpperCase() + modifier.slice(1);
  });
  return [...modifiers, keyLabel(binding.key)];
}

function keyLabel(key: string): string {
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}
