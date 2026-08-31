# Features

## Background

Four backgrounds are available for handwriting:

- None
- Lines
- Dots
- Squares

Background types are mutually exclusive. A file displays exactly one of None, Lines, Dots, or Squares.

Shared spacing for Lines, Dots, and Squares:

- S: 25
- M: 100 / 3 (approximately 33.333)
- L: 50
- XL: 100

When switching to a different background type, the file adopts the configured vault default for that type. If the same type is selected again, the spacing already stored in the file is retained.

The Background drill-in menu presents one shared absolute S/M/L/XL range: 25, 100 / 3, 50, and 100 page units. A named size has the same physical dimensions in every file and never depends on page-buffer settings. Lines, Dots, and Squares use these exact values without a type-specific multiplier. Moving the thumb immediately previews only the guide density without mutating the document, changing the current SVG envelope, or starting a height transition. Releasing or otherwise committing the control adopts the preview with exactly one undoable spacing change and schedules persistence. A committed background change preserves the active editor height but updates the next locked SVG envelope so that only one complete pattern row remains below the row containing the lowest annotation.

The current background selection is stored for each handwriting file.

The active page height always ends on a complete 100-unit writing row and never depends on the background type or spacing. A non-empty locked SVG instead ends on a complete row of its committed pattern, with one complete pattern row below the row containing the lowest annotation. One canonical inner page frame runs exactly from each fixed page margin to its opposite margin in both the active editor and standalone SVG. Squares place exact-spacing internal guides from the top-left origin and always close the right and bottom frame edges. Dots occupy exactly the same intersections as the corresponding square grid. Lines retain only the horizontal guides from the same spacing series. Pattern coverage extends by half a screen-space guide width, so terminal guides and dots are never clipped.

## Automatic Page Expansion

By default, the active editor keeps three empty writing lines below the content, while the locked preview keeps one.

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

The plugin uses the conservative shared element bounds to calculate an occupied extent, aligns it to the fixed background-independent 100-unit layout step, and then adds configured buffer rows:

```
aligned occupied extent
+ activeBufferLines × 100
```

The alignment step and buffer unit are both fixed at 100 page units. Background selection, S/M/L/XL, and buffer-count changes therefore cannot alter the physical size of a pattern.

The page is not remeasured after every pointer sample. After a committed geometry change, it grows when less than one writing line of active buffer remains and restores the configured buffer in one 180-millisecond height transition. Selection moves and geometry-handle gestures may request only a larger writing-row-aligned preview extent, and repeated pointer or autoscroll frames coalesce into the existing 180-millisecond transition without passive scroll stabilization. Cancellation returns to the captured original height. A successful commit retains at least the final rendered preview extent and the Store-derived extent, including through a time-sliced handle commit, so moved, resized, or structurally edited content cannot be clipped by a smaller post-gesture measurement.

When content is deleted, the active embed can shrink again. The active editor defaults to three empty writing lines below content. A non-empty patterned locked preview ends after the pattern row containing the lowest annotation plus exactly one additional pattern row. A non-empty preview without a visible pattern uses one additional 100-unit writing row. An empty page keeps the shared 2.5-writing-line minimum rounded up to a complete 100-unit writing row. The active per-file buffer remains configurable; locked trailing space is fixed to one row of the selected locked alignment so preview height follows content consistently. Unlock and Lock animate between these derived heights over 240 milliseconds. The page includes writable margins on all four sides; writing into the bottom margin triggers writing-row-aligned active growth that restores the complete margin below the occupied extent.

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
- change coordinate-system dimensionality or table column count
- arrange selection
- Paste
- Cut
- Erase all

Each such gesture is exactly one undo step.

The Undo and Redo toolbar buttons operate directly on the canvas history. Both remain visible in stable toolbar positions and are disabled when the corresponding action is unavailable.

Within the unlocked embed, `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` use an additional unified history maintained separately for each Obsidian pane. This history can chronologically combine canvas actions with changes to the surrounding Markdown.

Automatic changes to the handwriting height do not create undo steps.

## Annotation Ordering and Connections

Arrange actions change the stable back-to-front element order inside the fixed highlight or content render band. They never move highlighter elements above content. Bring forward and Send backward cross one adjacent unselected rank; Bring to front and Send to back move to the corresponding band boundary. Multi-selection reordering is stable and commits as one command.

Line and arrow endpoint connections follow every semantic target anchor that remains valid when a shape moves, scales, rotates, or changes geometry. This includes table anchors affected by a selected table's column-count change. Changing a coordinate system from 3D to 2D removes its third axis, so connections to that removed endpoint detach at their last resolved positions instead of following an anchor that no longer exists. The target change, every retained endpoint update, and every required detachment are one atomic history command. Target deletion, Cut, or erasing likewise detaches surviving external lines and arrows at their last resolved positions within the same command. Exact ordering and connection contracts are defined in [File Format and Geometry](file-format.md).

When the unified history is empty, the plugin does not automatically lock the embed. Instead, attached feedback indicates that the embed must be locked to continue undoing in Obsidian. This prevents existing canvas redo history from being lost unexpectedly.

## Copy, Cut, Delete, and Paste Elements

These actions apply to selected canvas elements, not to the entire embed.

Copy:

- serializes the selection's geometry and style as JSON
- removes the original IDs from the payload
- writes the complete prefixed payload through the interoperable system `text/plain` format
- additionally retains an in-session copy in case clipboard permissions are unavailable
- does not let an unresolved best-effort system write block the validated in-session payload or the next clipboard action
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
- Context-menu Paste places it exactly at the mouse, pen, or touch invocation point in page coordinates. It snapshots that point when the menu opens and applies no repeated-paste offset.
- `Ctrl/Cmd+V` uses the last pointer position recorded inside the current active editor session. If none exists, it uses the center of the visible canvas.
- Repeated Toolbar or keyboard paste of the same payload offsets each additional copy diagonally by 24 page units.

The shortcuts are captured through the active editor's owning document so they remain available after canvas or toolbar interaction. They only take effect when the pointer is over the active editor and no text field is focused. `Delete` uses the same scope, while `Backspace` remains native. Without a selection or valid ink payload, the normal Obsidian clipboard functions remain active. A copied payload whose system write failed remains authoritative in the in-session fallback, even if the platform returns an empty clipboard read.

## Canvas Context Menus

The canvas uses Obsidian's native `Menu` through the owning presentation document. It is invoked through:

- mouse or trackpad `contextmenu`
- a one-finger long press lasting at least 500 milliseconds, with at most 6 screen pixels of movement when it begins on an annotation or 10 screen pixels on empty canvas
- the keyboard Context Menu key or `Shift+F10` while the canvas input surface has focus

The single transparent input surface converts the invocation point to page coordinates and resolves an annotation through the spatial index. A mouse right-click or touch long press on an unselected annotation selects only that annotation before opening the menu. Invoking it on an already selected annotation preserves the complete selection. Invoking it on empty canvas preserves the current selection. Selection caused by menu invocation is not a history entry and does not dirty the file.

Moving beyond the long-press threshold, receiving a second touch, starting a pen gesture, losing the owning presentation, or cancelling the pointer prevents the touch menu from opening. A long press on an annotation always selects and opens the selection menu regardless of the active tool; it never starts that tool's gesture. The keyboard menu is positioned at the visible selection center, or at the visible canvas center when no selection exists. Mouse, pen, and touch menus snapshot their invocation point, which also becomes the exact Context-menu Paste position.

When a selection exists, the menu begins with:

1. Copy
2. Cut
3. Delete
4. a separator
5. Bring forward
6. Send backward
7. Bring to front
8. Send to back

The canvas section follows after a separator:

1. Paste, only when a valid ink clipboard payload is available
2. Copy embed
3. Erase all
4. Delete embed

Without a selection, the selection section is omitted. The four Arrange actions are flat entries because the public Obsidian `MenuItem` API exposes no submenu contract. Disabled boundary actions remain visible. Delete removes only the selected annotations with one undoable canvas command. Erase all and Delete embed retain their confirmation behavior. Exact icons, destructive styling, focus behavior, and host API usage are defined in [Embed UI](embed-ui.md#context-menu-presentation) and [Obsidian Integration](obsidian-integration.md#commands-menus-icons-and-styling).

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
- One finger scrolls the note, pans while zoomed, selects an annotation or clears an empty-canvas selection only after a confirmed short tap, moves only an annotation that was already selected before contact, or opens the context menu with the bounded long press defined above. Pan, scroll, pinch, and long press never change selection.
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
2. It inserts the custom `!inkbook` embed Markdown in a block-safe manner. The syntax references the SVG through a normal link but never creates a native Obsidian image embed.
3. The next mounted embed editor is activated automatically.
4. After the widget is mounted and measured on two consecutive animation frames, the new embed opens in editing mode. If this does not happen within two seconds, insertion remains intact and retryable shared feedback is shown over the active view or owning window.
5. Shared success feedback with an icon-only Undo action remains visible for five seconds.

Undo removes both the Markdown embed and the newly created file. The file is deleted through `FileManager.trashFile()` and therefore follows the user's Obsidian trash preference.

As soon as the first stroke is saved, the Undo feedback disappears automatically. If the feedback merely expires, the empty embed remains.

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

The save is awaited in full so that the new preview does not accidentally load the previous file state. A validated saved SVG and the aspect ratio derived from those exact SVG bytes are mounted atomically, including when the presentation is already locked. A failed save keeps the disabled editor mounted with its dirty state and presents Retry, Save local copy, and Cancel actions. Cancel restores the prior active camera and active height without discarding data.

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
