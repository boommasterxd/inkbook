# Features

## Background

Four backgrounds are available for handwriting:

- None
- Lines
- Dots
- Squares

Background types are mutually exclusive. A file displays exactly one of None, Lines, Dots, or Squares.

Line spacing:

- S: 50
- M: 100
- L: 150
- XL: 200

Grid spacing for dots and squares:

- S: 20
- M: 40
- L: 60
- XL: 80

When switching to a different background type, the file adopts the configured vault default for that type. If the same type is selected again, the spacing already stored in the file is retained.

The current background selection is stored for each handwriting file.

The page height always ends on a complete background line or grid cell. The bottom margin therefore does not cut off partial lines or squares.

## Automatic Page Expansion

By default, the plugin keeps three empty writing lines below the content.

All elements are taken into account for the calculation:

- pen strokes
- highlighters
- lines
- arrows
- rectangles
- ellipses
- triangles
- octagons
- parallelograms
- diamonds
- coordinate systems
- tables
- moved selections

The plugin uses the conservative shared element bounds to calculate an occupied extent, aligns it to the current background step, and then adds configured background-aligned buffer units:

```
aligned occupied extent
+ writingBufferLines × backgroundAlignedWritingUnit
```

With a lined background, the alignment step is the current line spacing. With a grid, it is the grid cell size. The buffer unit is the smallest whole number of background steps that is at least the file's writing-line height. This preserves complete background cells and makes the locked maximum of one buffer line deterministic for every valid combination.

The page is not remeasured after every pointer sample. After a committed geometry change, it grows when less than one writing line of active buffer remains and restores the configured buffer in one 180-millisecond height transition. The sole pre-commit exception is the bounded one-buffer-unit extension while a selection remains in the bottom-edge drag zone; its exact threshold, cancellation, and commit rules are defined in [File Format and Geometry](file-format.md).

When content is deleted, the active embed can shrink again. The active editor defaults to three empty writing lines below content. The locked preview has at most one empty writing line. Unlock and Lock animate between these derived heights over 240 milliseconds.

The exact active, locked, empty-page, and background-snapping equations are defined in [File Format and Geometry](file-format.md).

## Undo and Redo

Every completed canvas gesture is stored as a command, for example:

- add stroke
- remove elements
- move selection
- scale selection
- rotate selection
- modify shape
- change style
- arrange selection
- Paste
- Cut
- Erase all

Each such gesture is exactly one undo step.

The Undo and Redo toolbar buttons operate directly on the canvas history. They only appear when the corresponding action is available.

Within the unlocked embed, `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` use an additional unified history maintained separately for each Obsidian pane. This history can chronologically combine canvas actions with changes to the surrounding Markdown.

Automatic changes to the handwriting height do not create undo steps.

## Annotation Ordering and Connections

Arrange actions change the stable back-to-front element order inside the fixed highlight or content render band. They never move highlighter elements above content. Bring forward and Send backward cross one adjacent unselected rank; Bring to front and Send to back move to the corresponding band boundary. Multi-selection reordering is stable and commits as one command.

Line and arrow endpoint connections follow their semantic target anchors when a shape moves, scales, rotates, or changes geometry. The target change and every resulting endpoint update are one atomic history command. Target deletion, Cut, or erasing detaches surviving external lines and arrows at their last resolved positions within the same command. Exact ordering and connection contracts are defined in [File Format and Geometry](file-format.md).

When the unified history is empty, the plugin does not automatically lock the embed. Instead, a notice indicates that the embed must be locked to continue undoing in Obsidian. This prevents existing canvas redo history from being lost unexpectedly.

## Copy, Cut, Delete, and Paste Elements

These actions apply to selected canvas elements, not to the entire embed.

Copy:

- serializes the selection's geometry and style as JSON
- removes the original IDs from the payload
- writes a custom MIME format plus `text/plain`
- additionally retains an in-session copy in case clipboard permissions are unavailable
- preserves connections whose target is also selected through clipboard-local IDs; connections to unselected targets become free endpoints

The MIME identifier, versioned payload schema, validation rules, and limits are defined in [File Format and Geometry](file-format.md).

Cut:

- copies first
- then removes the selected elements only if the same session, clipboard operation, basis revision, exact selection, and selected record versions are still current
- creates one undo step
- detaches unselected dependent lines or arrows at their current endpoint before removing a selected target
- keeps the copied payload but removes nothing and creates no history entry if the selection changes, an element is edited, the presentation detaches, or the operation otherwise becomes stale while the worker or system clipboard is pending

Delete:

- removes the selection
- creates one undo step
- is triggered through the toolbar or `Delete`
- leaves `Backspace` available for normal text input

Paste:

- generates new IDs for all elements
- inserts all elements as one undo step
- then automatically activates Select
- selects the inserted elements
- remaps every clipboard-local target ID to the corresponding new document ID

Placement:

- Toolbar Paste places the selection in the center of the visible canvas area.
- Context-menu Paste places it at the right-click or long-press point.
- `Ctrl/Cmd+V` uses the last pointer position recorded inside the current active editor session. If none exists, it uses the center of the visible canvas.
- Repeatedly pasting the same payload offsets each additional copy diagonally by 24 page units.

The shortcuts only take effect when the pointer is over the active editor and no text field is focused. Without a selection or valid ink payload, the normal Obsidian clipboard functions remain active.

## Canvas Context Menus

The canvas uses Obsidian's native `Menu` through the owning presentation document. It is invoked through:

- mouse or trackpad `contextmenu`
- a one-finger long press lasting at least 500 milliseconds, with at most 6 screen pixels of movement when it begins on an annotation or 10 screen pixels on empty canvas
- the keyboard Context Menu key or `Shift+F10` while the canvas input surface has focus

The single transparent input surface converts the invocation point to page coordinates and resolves an annotation through the spatial index. A mouse right-click or touch long press on an unselected annotation selects only that annotation before opening the menu. Invoking it on an already selected annotation preserves the complete selection. Invoking it on empty canvas preserves the current selection. Selection caused by menu invocation is not a history entry and does not dirty the file.

Moving beyond the long-press threshold, receiving a second touch, starting a pen gesture, losing the owning presentation, or cancelling the pointer prevents the touch menu from opening. A long press on an annotation always selects and opens the selection menu regardless of the active tool; it never starts that tool's gesture. The keyboard menu is positioned at the visible selection center, or at the visible canvas center when no selection exists. Mouse and touch menus use their invocation point, which also becomes the Context-menu Paste position.

When a selection exists, the menu begins with:

1. Copy
2. Cut
3. Delete
4. a separator
5. Arrange, as a non-interactive label
6. Bring forward
7. Send backward
8. Bring to front
9. Send to back

The canvas section follows after a separator:

1. Paste, only when a valid ink clipboard payload is available
2. Copy embed
3. Erase all
4. Delete embed

Without a selection, the selection section is omitted. The four Arrange actions are flat entries beneath a labelled row because the public Obsidian `MenuItem` API exposes no submenu contract. Disabled boundary actions remain visible. Delete removes only the selected annotations with one undoable canvas command. Erase all and Delete embed retain their confirmation behavior. Exact icons, destructive styling, focus behavior, and host API usage are defined in [Embed UI](embed-ui.md#context-menu-presentation) and [Obsidian Integration](obsidian-integration.md#commands-menus-icons-and-styling).

## Copying the Entire Embed

"Copy embed" in the overflow or context menu does not copy the individual strokes. It copies the embed's complete Markdown code.

When a copied embed is pasted, the plugin presents a choice:

- Reference existing file
- Make duplicate

Reference uses the same SVG file. Changes to one instance therefore also appear in the other.

Duplicate creates and validates a new SVG file before replacing the file path in the pasted Markdown. Naming, placement, and collision behavior follow [Settings](settings.md) and the [Implementation Specification](specification.md).

## Finger and Pen Input

The following behavior applies by default:

- A pen draws.
- One finger scrolls the note, pans while zoomed, selects a touched annotation regardless of the active tool, or opens the context menu with the bounded long press defined above.
- Two fingers zoom.
- Finger drawing is disabled by default in the device-local setting for the current vault.

When finger drawing is enabled for this device and vault, the local toolbar toggle can allow finger input as a drawing tool for the current editor embed. Finger strokes use the simulated mouse pressure curve.

When the pen touches the screen, the plugin captures the pointer, prevents the browser gesture, records the current Obsidian scroll position, and restores that position in the same animation frame if the host scrolls before pointer release. A pen stroke must never move the Obsidian note.

Pen contact never acquires, releases, or restyles the native scroll owner, never changes the editor width, and never hides or covers the right-hand scrollbar gutter. The presentation-lifetime stability lease is already active before editor measurement. Scroll restoration is coalesced to at most one animation-frame callback and creates no document revision, history entry, React update, worker message, or save work. Pointer release, cancellation, lost capture, detachment, and plugin unload cancel the guard and release its gesture-local references.

## Inserting Handwriting with a Pen Tap

This feature detects the target through the registered CodeMirror extension outside an existing embed. The actual Markdown insertion and undo mutation use the Obsidian `Editor` API.

It is configured locally for each device and disabled by default. Its mode can be set to Handwriting.

A tap creates a new handwriting embed only when all of the following conditions are met:

- `pointerType` is exactly `pen`
- the regular pen tip is active
- no side button or eraser tip is active
- movement is no more than 10 screen pixels
- duration is no more than 500 milliseconds
- the targeted Markdown line is empty
- the line is not in YAML frontmatter
- the line is not in a backtick code block
- the tap is not inside an existing ink widget
- Handwriting is enabled in the plugin settings
- no other automatic insertion is already in progress

On success:

1. The plugin creates a new handwriting SVG file.
2. It inserts the embed Markdown in a block-safe manner.
3. The next mounted embed editor is activated automatically.
4. After the widget is mounted and measured on two consecutive animation frames, the new embed opens in editing mode. If this does not happen within two seconds, insertion remains intact and a retryable notice is shown.
5. A notice with Undo remains visible for five seconds.

Undo removes both the Markdown embed and the newly created file. The file is deleted through `FileManager.trashFile()` and therefore follows the user's Obsidian trash preference.

As soon as the first stroke is saved, the Undo notice disappears automatically. If the notice merely expires, the empty embed remains.

## Lock

The Lock button ends editing.

The process:

1. Input is disabled immediately.
2. The toolbar fades out.
3. A zoomed-in embed begins returning to width fit.
4. The camera and height animate toward width fit and the locked preview height over 240 milliseconds while the snapshot export and save run concurrently.
5. If saving is still running after the layout transition, the editor remains visible but disabled at the locked geometry.
6. After the exact saved revision and its static preview are ready, the preview fades in while the editor fades out over an independent 120 milliseconds.
7. The interactive editor is unmounted only after the crossfade completes.

The save is awaited in full so that the new preview does not accidentally load the previous file state. A failed save keeps the disabled editor mounted with its dirty state and presents Retry, Save local copy, and Cancel actions. Cancel restores the prior active camera and active height without discarding data.

## Overflow Functions

The following functions are particularly relevant for the handwriting embed:

- Copy embed
- Erase all
- Delete embed

Erase all first displays a confirmation and then removes all canvas elements through an undoable command.

Delete embed checks whether the same SVG file is still referenced in other notes.

- If there are other references, only this embed is removed.
- If there are no other references, the user can choose whether to delete only the embed or also the SVG file.

Reference resolution and recoverable deletion use the public APIs specified in [Obsidian Integration](obsidian-integration.md). An unresolved or not-yet-resolved metadata cache never authorizes file deletion.

## Related Documentation

- [Editor tools](editor-tools.md)
- [Core model](core-model.md)
- [File format](file-format.md)
- [Implementation specification](specification.md)
- [Quality and testing](quality-and-testing.md)
- [Settings](settings.md)
- [Obsidian integration](obsidian-integration.md)
