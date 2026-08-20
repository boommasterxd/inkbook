# Features and Settings Overview

This document is a short, non-normative product overview. The linked [specification overview](00-readme.md) remains authoritative.

## Features

- Annotate ordinary Obsidian Markdown notes without replacing Obsidian's editor, Properties, links, rendering, search, or hotkey system.
- Use Cursor for both native Markdown editing and annotation selection. Touch always selects an existing Inkbook element before a drawing tool can claim it.
- Draw with Pen, Highlighter, Line highlighter, and whole-element Eraser.
- Create Rectangle, Ellipse, Triangle, Diamond, Octagon, Line, Arrow, Table, and one Coordinate system tool with a 2D or 3D creation choice.
- Select with Cursor or annotation-only Lasso, then move, resize, rotate, restyle, group, reorder, duplicate, cut, copy, paste, or delete supported elements. Moving a selection near the top or bottom edge autoscrolls vertically.
- Keep line, outline, divider, guide, axis, and cap widths constant while resizing geometry.
- Attach either endpoint of a Line or Arrow to stable ports on supported shapes, Tables, and coordinate systems. Attached endpoints follow target movement, resize, rotation, and text reflow.
- Preserve freely chosen rotation such as 15 degrees across deselection, save, reload, Undo, and Redo, while snapping near absolute 0, 90, 180, and 270 degrees.
- Resize a Table as one object, drag its internal dividers without splitting it, and change its selected row and column counts from 1 through 200.
- Resize individual coordinate-system axes along their existing directions while preserving the shared origin and inter-axis angles.
- Infer `Text range`, `Text position`, or `Fixed` binding after creation and reproject text-bound annotations when Markdown wraps or moves.
- Zoom Markdown, backgrounds, annotations, selection, and hit testing together from 50 through 400 percent, then pan every available axis through native one-finger touch scrolling or secondary-button drag.
- Keep handwriting-only notes and annotations below the final Markdown line reachable by extending each concrete view with the same effective trailing scroll allowance as its native content.
- Apply none, ruled, squared, or dotted note backgrounds aligned to Obsidian's measured body line height.
- Use the same ordered Obsidian Undo and Redo history for Markdown and annotations in the owning editable pane.
- Store annotation data in one validated `.inkbook.json` sidecar per annotated note, with a YAML locator in the Markdown note.
- Run on supported desktop and Android Obsidian environments with keyboard, mouse, stylus, touch, software-keyboard, and screen-reader operation.
- Remain interactive with at least 5,000 annotations per note on every supported release device, with 10,000 annotations as the release stress workload.

## Toolbar and Stylebar

The view-local toolbar stays mounted while a separate note-header control changes only its visibility. It supports Floating and Docked presentation, configurable tool order, More Tools, Background, whole-note Zoom, Settings, and host-history Undo and Redo.

The contextual stylebar exposes:

| Tool or selection | Controls                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Pen               | Color, width, opacity, Pressure, smoothing, streamline, and thinning                                                   |
| Highlighter       | Color, width, opacity, and freehand or straight variant                                                                |
| Eraser            | Radius and whole-element behavior                                                                                      |
| Shapes            | Outline color, width, opacity, dash pattern, fill color, and independent fill opacity                                  |
| Line and Arrow    | Color, width, opacity, dash pattern, independent endpoint caps, straight or curved path, and endpoint attachment state |
| Coordinate system | Line style, positive-end cap, 2D or 3D creation choice, and grid density                                               |
| Table             | Line style plus creation or selected-object row and column counts                                                      |
| Selection         | Shared styles, text binding, grouping, z-order, duplicate, and delete where applicable                                 |
| Background        | Pattern, horizontal spacing, contrast, and reset                                                                       |

## Plugin Settings

Inkbook uses Obsidian's normal plugin settings and Obsidian's normal Hotkeys page.

| Group                | Settings and actions                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| General              | Floating or Docked toolbar, initial toolbar visibility, tool order, and dominant hand                                                       |
| Input and stylus     | Input mode, barrel-button erase, haptic feedback, and Pen Pressure                                                                          |
| Tool defaults        | Pen, Highlighter, Shape, Line, Arrow, Table, and coordinate-system creation presets                                                         |
| Appearance and zoom  | Default background, horizontal background spacing, contrast, default zoom, and remembered per-note zoom                                     |
| Storage and recovery | Adjacent or Vault-root sidecars, validated sidecar folder, confirmed migration, validation, retry, recovery cleanup, and annotation removal |
| Advanced             | Bounded debug logging, performance overlay, sanitized diagnostics export, and settings reset                                                |

Tool defaults initialize future elements. Selecting an existing element and changing its style updates that element instead of overwriting the creation preset. Inkbook inherits Obsidian's theme, font, locale, accent, reduced-motion behavior, Markdown features, search, and hotkey conflict management.

For exact defaults, validation, scope, persistence, and failure behavior, see [Settings](08-settings.md). For exact tools and interaction rules, see [Interaction and Tools](02-interaction-and-tools.md) and [Toolbar and Stylebar](03-toolbar-and-stylebar.md).
