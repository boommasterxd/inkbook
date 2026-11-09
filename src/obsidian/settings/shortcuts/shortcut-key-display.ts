import {
  createEnglishLocalization,
  type MessageKey,
  type Translator,
} from "../../../domain/localization";
import { Platform } from "obsidian";

import type { KeyboardShortcutBindingV1 } from "../../../domain/settings";
import type { ObsidianHotkeyBinding } from "./obsidian-hotkey-conflicts";

export function renderShortcutBinding(
  container: HTMLElement,
  binding: KeyboardShortcutBindingV1 | null,
  t: Translator = createEnglishLocalization().t,
): void {
  container.replaceChildren();
  if (binding === null) {
    container.createSpan({
      cls: "inkbook-shortcut-unassigned",
      text: t("settings.shortcuts.unassigned"),
    });
    return;
  }
  renderShortcutKeyGroups(container, [bindingParts(binding, t)], t);
}

export function renderReadOnlyShortcutBinding(
  container: HTMLElement,
  groups: readonly (readonly string[])[],
  t: Translator = createEnglishLocalization().t,
): void {
  if (groups.length === 0) {
    container.createSpan({
      cls: "inkbook-shortcut-unassigned",
      text: t("settings.shortcuts.unassigned"),
    });
    return;
  }
  renderShortcutKeyGroups(container, groups, t);
}

export function obsidianHotkeyParts(binding: ObsidianHotkeyBinding): readonly string[] {
  return [...binding.modifiers, binding.key];
}

function renderShortcutKeyGroups(
  container: HTMLElement,
  groups: readonly (readonly string[])[],
  t: Translator = createEnglishLocalization().t,
): void {
  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0)
      container.createSpan({
        cls: "inkbook-shortcut-alternative",
        text: t("settings.shortcuts.or"),
      });
    for (const part of group) container.createEl("kbd", { text: fixedKeyLabel(part, t) });
  });
}

const KEY_LABELS = {
  Space: "settings.shortcuts.key.Space",
  Click: "settings.shortcuts.key.Click",
  Wheel: "settings.shortcuts.key.Wheel",
  PageUp: "settings.shortcuts.key.PageUp",
  PageDown: "settings.shortcuts.key.PageDown",
  Home: "settings.shortcuts.key.Home",
  End: "settings.shortcuts.key.End",
  Enter: "settings.shortcuts.key.Enter",
  Escape: "settings.shortcuts.key.Escape",
  Shift: "settings.shortcuts.key.Shift",
  Ctrl: "settings.shortcuts.key.Ctrl",
  Alt: "settings.shortcuts.key.Alt",
  Meta: "settings.shortcuts.key.Meta",
} as const satisfies Readonly<Record<string, MessageKey>>;

function fixedKeyLabel(part: string, t: Translator): string {
  const key = part === "Mod" ? (Platform.isMacOS ? "⌘" : "Ctrl") : part;
  const message = KEY_LABELS[key as keyof typeof KEY_LABELS];
  return message === undefined ? key : t(message);
}

function bindingParts(binding: KeyboardShortcutBindingV1, t: Translator): readonly string[] {
  const modifiers = binding.modifiers.map((modifier) => {
    if (modifier === "mod") return Platform.isMacOS ? "⌘" : t("settings.shortcuts.key.Ctrl");
    if (modifier === "meta") return t("settings.shortcuts.key.Meta");
    return fixedKeyLabel((modifier[0]?.toUpperCase() ?? "") + modifier.slice(1), t);
  });
  return [...modifiers, keyLabel(binding.key, t)];
}

function keyLabel(key: string, t: Translator): string {
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  if (key === " ") return t("settings.shortcuts.key.Space");
  return key.length === 1 ? key.toUpperCase() : fixedKeyLabel(key, t);
}
