# Keyboard Shortcuts

## Ownership and Scope

Inkbook separates canvas-local keyboard bindings from Obsidian commands. A canvas-local binding is handled by the active editor only when no text input, text area, select control, or content-editable element owns the event. A key or native Paste event dispatched directly to the focused canvas remains canvas-owned after Android touch hover ends; document-level handling outside that surface additionally requires the pointer to remain over the complete active embed, including its toolbar. Clipboard work restores canvas focus after its temporary inert interval unless the user moved focus elsewhere, preserving immediate repeated shortcuts without pointer hover. Copy and Cut are claimed only when a selection exists. Paste is claimed when the platform can perform a bounded system Clipboard read, a validated in-session payload exists, or another claimed Clipboard operation is still pending; on older platforms, the native Paste event provides the synchronous payload instead. Every claimed trigger uses the same success animation and explicit invalid, permission, pipeline-failure, or busy feedback instead of failing silently.

`Mod` means `Cmd` on macOS and `Ctrl` on other platforms. Configurable bindings are local to one device and vault. They are not written into an Inkbook SVG and do not synchronize through plugin data.

## Configurable Canvas Bindings

| Action           | Built-in binding      | Availability                                               |
| ---------------- | --------------------- | ---------------------------------------------------------- |
| Select all       | `Mod+A`               | An active Inkbook editor exists                            |
| Copy selection   | `Mod+C`               | A selection exists and the canvas owns the key event       |
| Cut selection    | `Mod+X`               | A selection exists and the canvas owns the key event       |
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

The native Markdown editor context menu offers **Insert handwriting embed** only on an empty ordinary Markdown line outside YAML frontmatter and backtick code blocks, while no insertion is in progress. Pen-tap eligibility is defined in [Features](features.md#inserting-handwriting-with-a-pen-tap). Pointer context menus use the clicked line; keyboard context menus use the cursor line. Inkbook does not change the cursor or selection when opening the menu. The menu action and accepted pen taps select their captured target line and invoke the same registered `editorCheckCallback` as the Obsidian command, rechecking availability at execution. Availability queries use `canInsert`; execution delegates directly to the request method, which performs its own authoritative validation once. A pen tap additionally checks its captured target before moving the cursor. The target is validated again after asynchronous SVG preparation and verification before Markdown is changed.

## Settings Interface

The Inkbook settings tab ends with a Shortcuts group. Canvas shortcuts, fixed system shortcuts, pointer and gesture modifiers, and Obsidian commands use the same native setting surface, typography, inline inset, bounded dividers, outer radius, right-aligned chevron, disclosure semantics, and measured motion behavior as tool-default sections. Every section is collapsed when the view opens. Expanded shortcut and reference entries reuse native setting-item name, description, control structure, theme-aware shortcut field, and platform-aware keycaps. The Canvas shortcuts section additionally contains the interactive recorder, `aria-pressed` recording state, `aria-live` conflict status, and labelled per-action Reset and Clear buttons. A caution-toned `Reset group to defaults` action remains at the actual bottom of the complete Shortcuts group and restores every configurable binding. Fixed, pointer, gesture, and Obsidian command bindings remain read-only without interactive recorder, Reset, or Clear controls. When narrow layouts place a shortcut field below its description, read-only fields fill the available content width; editable recorders share the full row width with their Reset and Clear buttons.

The active toolbar Overflow menu contains `Settings` and `Keyboard shortcuts`. Both open an Inkbook-owned modal implemented with public Obsidian APIs. `Settings` contains only the general settings view, while `Keyboard shortcuts` contains only the shortcut view; neither modal adds an internal view switcher. Phone controls retain at least 44 CSS-pixel targets and reflow to one shortcut row per line without horizontal overflow.

Changes to unrelated device preferences preserve the mounted shortcut controls, focus, and recording state. Only changes to the configurable binding map refresh the shortcut view; explicit recording and conflict feedback continue to update their own interaction state.

## Persistence and Migration

Device settings version 2 stores the configurable binding map under `inkbook:device-settings:v2`. A valid version 1 device value is migrated by preserving finger drawing, pen-tap insertion, handedness, and motion while adding the built-in shortcut map. The migrated version 2 value is persisted under the new key. Invalid bindings fall back independently, and duplicate fallback resolution never creates another conflict.
