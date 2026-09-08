import { Platform, type App } from "obsidian";

import {
  canonicalShortcutKey,
  type KeyboardShortcutBindingV1,
  type ShortcutModifierV1,
} from "../../domain/settings/index";

export interface ObsidianHotkeyBinding {
  readonly key: string;
  readonly modifiers: readonly string[];
}

export interface ObsidianHotkeyAccess {
  findConflict(binding: KeyboardShortcutBindingV1): string | undefined;
  readBindings(): ReadonlyMap<string, readonly ObsidianHotkeyBinding[]>;
}

interface PrivateHotkeyManager {
  readonly customKeys?: unknown;
  readonly defaultKeys?: unknown;
}

interface AppWithPrivateHotkeys extends App {
  readonly hotkeyManager?: PrivateHotkeyManager;
}

interface EffectiveHotkey {
  readonly commandId: string;
  readonly hotkey: ObsidianHotkeyBinding;
}

export function createObsidianHotkeyAccess(app: App): ObsidianHotkeyAccess {
  return {
    findConflict: (binding) => findObsidianHotkeyConflict(app, binding),
    readBindings: () => readObsidianHotkeyBindings(app),
  };
}

export function findObsidianHotkeyConflict(
  app: App,
  binding: KeyboardShortcutBindingV1,
): string | undefined {
  const manager = (app as AppWithPrivateHotkeys).hotkeyManager;
  if (manager === undefined) return undefined;
  for (const entry of effectiveHotkeys(manager)) {
    if (samePhysicalBinding(binding, entry.hotkey)) return entry.commandId;
  }
  return undefined;
}

export function readObsidianHotkeyBindings(
  app: App,
): ReadonlyMap<string, readonly ObsidianHotkeyBinding[]> {
  const manager = (app as AppWithPrivateHotkeys).hotkeyManager;
  if (manager === undefined) return new Map();
  return effectiveHotkeyMap(manager);
}

function effectiveHotkeys(manager: PrivateHotkeyManager): EffectiveHotkey[] {
  const result: EffectiveHotkey[] = [];
  for (const [commandId, hotkeys] of effectiveHotkeyMap(manager)) {
    for (const hotkey of hotkeys) result.push({ commandId, hotkey });
  }
  return result;
}

function effectiveHotkeyMap(
  manager: PrivateHotkeyManager,
): ReadonlyMap<string, readonly ObsidianHotkeyBinding[]> {
  const defaults = hotkeyMap(manager.defaultKeys);
  const custom = hotkeyMap(manager.customKeys);
  if (defaults === undefined && custom === undefined) return new Map();
  const customizedCommandIds = new Set(Object.keys(custom ?? {}));
  const commandIds = new Set([...Object.keys(defaults ?? {}), ...Object.keys(custom ?? {})]);
  const result = new Map<string, readonly ObsidianHotkeyBinding[]>();
  for (const commandId of commandIds) {
    const hotkeys = customizedCommandIds.has(commandId)
      ? custom?.[commandId]
      : defaults?.[commandId];
    if (hotkeys === undefined) continue;
    result.set(commandId, hotkeys);
  }
  return result;
}

function hotkeyMap(
  value: unknown,
): Readonly<Record<string, readonly ObsidianHotkeyBinding[]>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result = Object.create(null) as Record<string, readonly ObsidianHotkeyBinding[]>;
  for (const [commandId, candidate] of Object.entries(value)) {
    if (!Array.isArray(candidate)) continue;
    if (!candidate.every(isHotkey)) continue;
    result[commandId] = candidate.map((hotkey) => ({
      key: hotkey.key,
      modifiers: [...hotkey.modifiers],
    }));
  }
  return result;
}

function isHotkey(value: unknown): value is ObsidianHotkeyBinding {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly key?: unknown; readonly modifiers?: unknown };
  return (
    typeof candidate.key === "string" &&
    Array.isArray(candidate.modifiers) &&
    candidate.modifiers.every((modifier) => typeof modifier === "string")
  );
}

function samePhysicalBinding(
  binding: KeyboardShortcutBindingV1,
  hotkey: ObsidianHotkeyBinding,
): boolean {
  if (canonicalShortcutKey(hotkey.key) !== canonicalShortcutKey(binding.key)) return false;
  const candidateModifiers = physicalModifiers(binding.modifiers);
  const hostModifiers = physicalObsidianModifiers(hotkey.modifiers);
  return candidateModifiers.every((active, index) => active === hostModifiers[index]);
}

function physicalModifiers(modifiers: readonly ShortcutModifierV1[]): readonly boolean[] {
  return [
    modifiers.includes("ctrl") || (!Platform.isMacOS && modifiers.includes("mod")),
    modifiers.includes("meta") || (Platform.isMacOS && modifiers.includes("mod")),
    modifiers.includes("shift"),
    modifiers.includes("alt"),
  ];
}

function physicalObsidianModifiers(modifiers: readonly string[]): readonly boolean[] {
  return [
    modifiers.includes("Ctrl") || (!Platform.isMacOS && modifiers.includes("Mod")),
    modifiers.includes("Meta") || (Platform.isMacOS && modifiers.includes("Mod")),
    modifiers.includes("Shift"),
    modifiers.includes("Alt"),
  ];
}
