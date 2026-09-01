# Keyboard Shortcuts

## Ownership and Scope

Inkbook separates canvas-local keyboard bindings from Obsidian commands. A canvas-local binding is handled by the active editor only when no text input, text area, select control, or content-editable element owns the event. Document-level handling additionally requires the pointer to remain over that active editor. Clipboard actions are claimed only when their canvas action is available, so unavailable Inkbook actions do not suppress native Obsidian clipboard behavior.

`Mod` means `Cmd` on macOS and `Ctrl` on other platforms. Configurable bindings are local to one device and vault. They are not written into an Inkbook SVG and do not synchronize through plugin data.

## Configurable Canvas Bindings

| Action           | Built-in binding      | Availability                                               |
| ---------------- | --------------------- | ---------------------------------------------------------- |
| Select all       | `Mod+A`               | An active Inkbook editor exists                            |
| Copy selection   | `Mod+C`               | A selection exists and the pointer is over the editor      |
| Cut selection    | `Mod+X`               | A selection exists and the pointer is over the editor      |
| Delete selection | `Delete`              | A selection exists                                         |
| Zoom in          | `Mod++`               | Navigation is available and the pointer is over the editor |
| Zoom out         | `Mod+-`               | Navigation is available and the pointer is over the editor |
| Bring forward    | `Mod+ArrowUp`         | The selection can move one rank forward                    |
| Send backward    | `Mod+ArrowDown`       | The selection can move one rank backward                   |
| Bring to front   | `Mod+Shift+ArrowUp`   | The selection can move to the front of its render band     |
| Send to back     | `Mod+Shift+ArrowDown` | The selection can move to the back of its render band      |

Each binding may be recorded, cleared, or reset independently. `Reset all` restores this complete table. Two canvas actions cannot share one canonical binding. Modifier order and letter case do not create distinct bindings. Bare printable characters, accessibility navigation keys, bindings reserved by the fixed system controls, and currently effective Obsidian command bindings are rejected with an inline error. The recorder owns the key event in the capture phase while active, so a rejected Obsidian binding does not execute its host command. A cleared action remains unassigned until it is recorded or reset.

The current Obsidian API does not publicly expose effective host bindings. One isolated read-only gateway therefore reads `app.hotkeyManager.defaultKeys` and `app.hotkeyManager.customKeys`. A custom entry replaces the corresponding default completely, including an empty array that deliberately clears a default. The gateway validates the private data shape, reads it again for every recording attempt, mutates no host state, and fails open when the private structure is unavailable or malformed. No other Inkbook feature may consume this private manager. The gateway must be replaced as soon as Obsidian provides an equivalent public API.

Keyboard zoom accepts the layout-equivalent `=` and numeric-keypad `Add` events for Zoom in, and `_` and numeric-keypad `Subtract` events for Zoom out. The zoom step and pointer anchor remain identical regardless of which equivalent key event the active keyboard layout produces.

## Fixed System Bindings

These bindings are intentionally not editable because their event ownership or history semantics must remain stable:

| Action          | Binding       | Reason                                                                            |
| --------------- | ------------- | --------------------------------------------------------------------------------- |
| Paste           | `Mod+V`       | Cooperates with the system clipboard event and validated Inkbook payload boundary |
| Undo            | `Mod+Z`       | Traverses the pane-scoped unified Markdown and canvas history                     |
| Redo            | `Mod+Shift+Z` | Traverses the same unified history without creating a parallel undo path          |
| Cancel or close | `Escape`      | Closes a surface, cancels a gesture, then clears selection in that order          |
| Context menu    | `Shift+F10`   | Preserves the platform accessibility convention                                   |

Toolbar Undo and Redo still operate directly on canvas history. The fixed keyboard bindings use the pane-scoped unified history and pass a Markdown-owned step back to Obsidian. Canvas command commits, including configurable Delete and arrange bindings, remain exactly one undo step.

## Pointer and Gesture Modifiers

The following transient modifiers are interaction contracts rather than configurable keyboard shortcuts:

| Interaction                                    | Modifier                              |
| ---------------------------------------------- | ------------------------------------- |
| Extend the current selection                   | `Mod+click`                           |
| Preserve aspect ratio while resizing           | Hold `Shift`                          |
| Add an area selection                          | Hold `Shift` when starting the area   |
| Temporarily invert snapping                    | Hold `Alt` during the pointer gesture |
| Temporarily use the eraser from a drawing tool | Hold `Mod`                            |
| Pointer-centered wheel zoom                    | `Mod+wheel`                           |
| Horizontal wheel navigation                    | `Shift+wheel`                         |

## Obsidian Commands

Only actions that remain useful outside the internal canvas keyboard scope are registered with `Plugin.addCommand()`:

- Lock active handwriting embed
- Copy active embed
- Erase all annotations
- Delete active embed
- Insert handwriting embed

Inkbook assigns no default hotkeys to these commands. Users may configure them in Obsidian Settings under Hotkeys. The Inkbook shortcut view displays each effective Obsidian binding in the same read-only keycap field as other reference bindings and displays `Not assigned` when the command has no effective binding. Copy, Cut, Paste, Delete selection, Select all, Zoom, Undo, Redo, and the four arrange actions are not duplicated as Obsidian commands.

## Settings Interface

The Inkbook settings tab ends with a Shortcuts group. Canvas shortcuts, fixed system shortcuts, pointer and gesture modifiers, and Obsidian commands use the same native setting surface, typography, inline inset, bounded dividers, outer radius, right-aligned chevron, disclosure semantics, and measured motion behavior as tool-default sections. Every section is collapsed when the view opens. Expanded shortcut and reference entries reuse native setting-item name, description, control structure, white shortcut field, and platform-aware keycaps. The Canvas shortcuts section additionally contains the interactive recorder, `aria-pressed` recording state, `aria-live` conflict status, and labelled per-action Reset and Clear buttons. A caution-toned `Reset group to defaults` action remains at the actual bottom of the complete Shortcuts group and restores every configurable binding. Fixed, pointer, gesture, and Obsidian command bindings remain read-only without interactive recorder, Reset, or Clear controls.

The active toolbar Overflow menu contains `Settings` and `Keyboard shortcuts`. Both open an Inkbook-owned modal implemented with public Obsidian APIs. `Settings` contains only the general settings view, while `Keyboard shortcuts` contains only the shortcut view; neither modal adds an internal view switcher. Phone controls retain at least 44 CSS-pixel targets and reflow to one shortcut row per line without horizontal overflow.

## Persistence and Migration

Device settings version 2 stores the configurable binding map under `inkbook:device-settings:v2`. A valid version 1 device value is migrated by preserving finger drawing, pen-tap insertion, handedness, and motion while adding the built-in shortcut map. The migrated version 2 value is persisted under the new key. Invalid bindings fall back independently, and duplicate fallback resolution never creates another conflict.
