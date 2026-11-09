import type { Translator } from "../../../domain/localization";
import type { ConfigurableShortcutActionV1 } from "../../../domain/settings/index";

export interface ShortcutReferenceEntry {
  readonly description: string;
  readonly label: string;
}

export interface FixedShortcutReferenceEntry extends ShortcutReferenceEntry {
  readonly keyGroups: readonly (readonly string[])[];
}

export interface ObsidianCommandReferenceEntry extends ShortcutReferenceEntry {
  readonly commandId: string;
}

export function configurableShortcutReference(
  t: Translator,
): Readonly<Record<ConfigurableShortcutActionV1, ShortcutReferenceEntry>> {
  return {
    "select-all": {
      label: t("settings.shortcuts.reference.select-all.label"),
      description: t("settings.shortcuts.reference.select-all.description"),
    },
    copy: {
      label: t("settings.shortcuts.reference.copy-selection.label"),
      description: t("settings.shortcuts.reference.copy-selection.description"),
    },
    cut: {
      label: t("settings.shortcuts.reference.cut-selection.label"),
      description: t("settings.shortcuts.reference.cut-selection.description"),
    },
    "delete-selection": {
      label: t("settings.shortcuts.reference.delete-selection.label"),
      description: t("settings.shortcuts.reference.delete-selection.description"),
    },
    "zoom-in": {
      label: t("settings.shortcuts.reference.zoom-in.label"),
      description: t("settings.shortcuts.reference.zoom-in.description"),
    },
    "zoom-out": {
      label: t("settings.shortcuts.reference.zoom-out.label"),
      description: t("settings.shortcuts.reference.zoom-out.description"),
    },
    "bring-forward": {
      label: t("settings.shortcuts.reference.bring-forward.label"),
      description: t("settings.shortcuts.reference.bring-forward.description"),
    },
    "send-backward": {
      label: t("settings.shortcuts.reference.send-backward.label"),
      description: t("settings.shortcuts.reference.send-backward.description"),
    },
    "bring-to-front": {
      label: t("settings.shortcuts.reference.bring-to-front.label"),
      description: t("settings.shortcuts.reference.bring-to-front.description"),
    },
    "send-to-back": {
      label: t("settings.shortcuts.reference.send-to-back.label"),
      description: t("settings.shortcuts.reference.send-to-back.description"),
    },
  };
}

export function fixedShortcutReference(t: Translator) {
  return [
    {
      description: t("settings.shortcuts.reference.navigate-objects.description"),
      keyGroups: [["PageUp"], ["PageDown"]],
      label: t("settings.shortcuts.reference.navigate-objects.label"),
    },
    {
      description: t("settings.shortcuts.reference.first-or-last-object.description"),
      keyGroups: [["Home"], ["End"]],
      label: t("settings.shortcuts.reference.first-or-last-object.label"),
    },
    {
      description: t("settings.shortcuts.reference.edit-geometry.description"),
      keyGroups: [["Enter"]],
      label: t("settings.shortcuts.reference.edit-geometry.label"),
    },
    {
      description: t("settings.shortcuts.reference.adjust-geometry.description"),
      keyGroups: [["ArrowLeft"], ["ArrowRight"], ["ArrowUp"], ["ArrowDown"]],
      label: t("settings.shortcuts.reference.adjust-geometry.label"),
    },
    {
      description: t("settings.shortcuts.reference.paste.description"),
      keyGroups: [["Mod", "V"]],
      label: t("settings.shortcuts.reference.paste.label"),
    },
    {
      description: t("settings.shortcuts.reference.undo.description"),
      keyGroups: [["Mod", "Z"]],
      label: t("settings.shortcuts.reference.undo.label"),
    },
    {
      description: t("settings.shortcuts.reference.redo.description"),
      keyGroups: [["Mod", "Shift", "Z"]],
      label: t("settings.shortcuts.reference.redo.label"),
    },
    {
      description: t("settings.shortcuts.reference.cancel-or-close.description"),
      keyGroups: [["Escape"]],
      label: t("settings.shortcuts.reference.cancel-or-close.label"),
    },
    {
      description: t("settings.shortcuts.reference.context-menu.description"),
      keyGroups: [["Shift", "F10"]],
      label: t("settings.shortcuts.reference.context-menu.label"),
    },
  ] as const satisfies readonly FixedShortcutReferenceEntry[];
}

export function gestureModifierReference(t: Translator) {
  return [
    {
      description: t("settings.shortcuts.reference.extend-selection.description"),
      keyGroups: [["Mod", "Click"]],
      label: t("settings.shortcuts.reference.extend-selection.label"),
    },
    {
      description: t("settings.shortcuts.reference.keep-aspect-ratio.description"),
      keyGroups: [["Shift"]],
      label: t("settings.shortcuts.reference.keep-aspect-ratio.label"),
    },
    {
      description: t("settings.shortcuts.reference.add-area-selection.description"),
      keyGroups: [["Shift"]],
      label: t("settings.shortcuts.reference.add-area-selection.label"),
    },
    {
      description: t("settings.shortcuts.reference.invert-snapping.description"),
      keyGroups: [["Alt"]],
      label: t("settings.shortcuts.reference.invert-snapping.label"),
    },
    {
      description: t("settings.shortcuts.reference.temporary-eraser.description"),
      keyGroups: [["Mod"]],
      label: t("settings.shortcuts.reference.temporary-eraser.label"),
    },
    {
      description: t("settings.shortcuts.reference.pointer-zoom.description"),
      keyGroups: [["Mod", "Wheel"]],
      label: t("settings.shortcuts.reference.pointer-zoom.label"),
    },
    {
      description: t("settings.shortcuts.reference.horizontal-navigation.description"),
      keyGroups: [["Shift", "Wheel"]],
      label: t("settings.shortcuts.reference.horizontal-navigation.label"),
    },
  ] as const satisfies readonly FixedShortcutReferenceEntry[];
}

export function obsidianCommandReference(t: Translator) {
  return [
    {
      commandId: "inkbook:lock-active-embed",
      description: t("settings.shortcuts.reference.lock-active-handwriting-embed.description"),
      label: t("settings.shortcuts.reference.lock-active-handwriting-embed.label"),
    },
    {
      commandId: "inkbook:copy-embed",
      description: t("settings.shortcuts.reference.copy-active-embed.description"),
      label: t("settings.shortcuts.reference.copy-active-embed.label"),
    },
    {
      commandId: "inkbook:erase-all",
      description: t("settings.shortcuts.reference.erase-all-annotations.description"),
      label: t("settings.shortcuts.reference.erase-all-annotations.label"),
    },
    {
      commandId: "inkbook:delete-embed",
      description: t("settings.shortcuts.reference.delete-active-embed.description"),
      label: t("settings.shortcuts.reference.delete-active-embed.label"),
    },
    {
      commandId: "inkbook:insert-handwriting",
      description: t("settings.shortcuts.reference.insert-handwriting-embed.description"),
      label: t("settings.shortcuts.reference.insert-handwriting-embed.label"),
    },
  ] as const satisfies readonly ObsidianCommandReferenceEntry[];
}
