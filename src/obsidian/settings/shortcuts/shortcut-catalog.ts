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

export const CONFIGURABLE_SHORTCUT_REFERENCE: Readonly<
  Record<ConfigurableShortcutActionV1, ShortcutReferenceEntry>
> = Object.freeze({
  "select-all": { label: "Select all", description: "Select every element in the canvas." },
  copy: { label: "Copy selection", description: "Copy the current selection." },
  cut: { label: "Cut selection", description: "Copy and remove the current selection." },
  "delete-selection": {
    label: "Delete selection",
    description: "Remove the current selection as one undo step.",
  },
  "zoom-in": { label: "Zoom in", description: "Zoom around the latest canvas pointer." },
  "zoom-out": { label: "Zoom out", description: "Zoom around the latest canvas pointer." },
  "bring-forward": {
    label: "Bring forward",
    description: "Move the selection one position toward the front.",
  },
  "send-backward": {
    label: "Send backward",
    description: "Move the selection one position toward the back.",
  },
  "bring-to-front": {
    label: "Bring to front",
    description: "Move the selection to the front of its render band.",
  },
  "send-to-back": {
    label: "Send to back",
    description: "Move the selection to the back of its render band.",
  },
});

export const FIXED_SHORTCUT_REFERENCE = [
  {
    description: "Paste a validated clipboard selection at the current canvas target.",
    keyGroups: [["Mod", "V"]],
    label: "Paste",
  },
  {
    description: "Undo the latest pane-scoped Markdown or canvas action.",
    keyGroups: [["Mod", "Z"]],
    label: "Undo",
  },
  {
    description: "Redo the latest pane-scoped Markdown or canvas action.",
    keyGroups: [["Mod", "Shift", "Z"]],
    label: "Redo",
  },
  {
    description: "Close a surface, cancel a gesture, or clear the current selection.",
    keyGroups: [["Escape"]],
    label: "Cancel or close",
  },
  {
    description: "Open the canvas context menu with a platform accessibility shortcut.",
    keyGroups: [["Shift", "F10"]],
    label: "Context menu",
  },
] as const satisfies readonly FixedShortcutReferenceEntry[];

export const GESTURE_MODIFIER_REFERENCE = [
  {
    description: "Add the clicked element to the current selection.",
    keyGroups: [["Mod", "Click"]],
    label: "Extend selection",
  },
  {
    description: "Preserve the selection's aspect ratio while resizing.",
    keyGroups: [["Shift"]],
    label: "Keep aspect ratio",
  },
  {
    description: "Add the area result to the current selection.",
    keyGroups: [["Shift"]],
    label: "Add area selection",
  },
  {
    description: "Temporarily use the opposite snapping state.",
    keyGroups: [["Alt"]],
    label: "Invert snapping",
  },
  {
    description: "Temporarily erase while a drawing tool is active.",
    keyGroups: [["Mod"]],
    label: "Temporary eraser",
  },
  {
    description: "Zoom around the current pointer position.",
    keyGroups: [["Mod", "Wheel"]],
    label: "Pointer zoom",
  },
  {
    description: "Navigate horizontally with the wheel.",
    keyGroups: [["Shift", "Wheel"]],
    label: "Horizontal navigation",
  },
] as const satisfies readonly FixedShortcutReferenceEntry[];

export const OBSIDIAN_COMMAND_REFERENCE = [
  {
    commandId: "inkbook:lock-active-embed",
    description: "Lock the currently active handwriting embed.",
    label: "Lock active handwriting embed",
  },
  {
    commandId: "inkbook:copy-embed",
    description: "Copy the currently active embed reference.",
    label: "Copy active embed",
  },
  {
    commandId: "inkbook:erase-all",
    description: "Remove every annotation from the active embed.",
    label: "Erase all annotations",
  },
  {
    commandId: "inkbook:delete-embed",
    description: "Delete the currently active embed.",
    label: "Delete active embed",
  },
  {
    commandId: "inkbook:insert-handwriting",
    description: "Insert a new handwriting embed in the active note.",
    label: "Insert handwriting embed",
  },
] as const satisfies readonly ObsidianCommandReferenceEntry[];
