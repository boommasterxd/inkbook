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
- five-point stars
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

Membership replay uses the [shared history fade](quality-and-testing.md#animation-contract): an action that removes elements fades them out, and an action that restores elements fades them in. The direction follows the resulting membership, so Redo of erasing fades out while Undo of erasing fades in. The same rule applies to toolbar and keyboard traversal.

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
- contains rejected text and Blob payload promises even when the host never consumes them after ClipboardItem construction or write failure; encoding failure remains an explicit failed Copy or Cut result
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
- is triggered through the toolbar, selection context menu, or `Delete`
- previews a 150 ms opacity fade using retained scene nodes and bounded animation starts; committing does not wait for the animation
- restores pending feedback if preparation fails or becomes stale; Undo during the fade restores the element without leftover opacity changes
- leaves `Backspace` available for normal text input

Paste:

- generates new IDs for all elements
- inserts all elements as one undo step
- selects the inserted elements; Toolbar and keyboard Paste activate Select, while Context-menu Paste preserves the current creation tool so the menu-closing touch cannot become a lasso gesture
- remaps every clipboard-local target ID to the corresponding new document ID

Placement:

- Toolbar Paste places the selection in the center of the visible canvas area.
- Context-menu Paste places it exactly at the mouse, pen, or touch invocation point in page coordinates. It snapshots that point when the menu opens and applies no repeated-paste offset.
- `Ctrl/Cmd+V` uses the last pointer position recorded inside the current active editor session. If none exists, it uses the center of the visible canvas.
- Repeated Toolbar or keyboard paste of the same payload offsets each additional copy diagonally by 24 page units.

Canvas shortcuts are captured through the active editor's owning document so they remain available after canvas or toolbar interaction. Document-level capture requires the pointer over the complete active embed, including its toolbar, and no focused text field. A key or native Paste event targeted directly at the focused input surface remains owned after a touch pointer leaves its Android hover boundary. Clipboard work temporarily makes that surface inert, but restores its focus after completion when focus did not move to another control, so an immediate repeated shortcut remains canvas-owned without hover. `Delete` uses the same availability boundary, while `Backspace` remains native. A keyboard Paste explicitly reads the system clipboard when the platform exposes `Clipboard.read()`; without that API, the native Paste event supplies synchronous clipboard data. Toolbar and context-menu Paste also start their clipboard read only after explicit activation. Invalid data, permission or read failure, unexpected decoding or commit failure, stale document state, and overlapping Clipboard work each produce explicit feedback; failed or invalid system reads do not hide Paste, so the user can retry. A claimed trigger never silently does nothing or shows a success animation before the corresponding operation succeeds.

The toolbar and context-menu Paste actions are available when the platform exposes `Clipboard.read()` or Inkbook has a validated in-session payload. This availability means only that the action can be attempted; it does not claim that the system clipboard contains Inkbook data or that permission has been granted. No background clipboard reads or permission queries run during activation, enabling, or pointer entry. On explicit Paste, Inkbook considers only the first system Clipboard item and requests each supported representation present there: the standards-prefixed Inkbook custom MIME type and `text/plain`. Each request returns the complete representation as a Blob; the 8 MiB per-representation limit is checked after the Blob returns, followed by the combined 16 MiB candidate limit. A read failure, invalid data, or limit violation leaves the Paste action available for retry. These application limits do not establish a bound on the host's underlying clipboard transfer. Paste validates the complete payload and document limits before committing, while retaining the existing busy feedback, cooperative planning, and failure handling. A copied payload whose system write failed remains available through the validated in-session fallback. Configurable bindings, fixed Paste and history bindings, and command ownership are canonical in [Keyboard Shortcuts](keyboard-shortcuts.md).

## Canvas Context Menus

The canvas uses a lifecycle-owned Inkbook menu with host-matching appearance through the owning presentation document. It is invoked through:

- mouse or trackpad `contextmenu`
- a one-finger long press lasting at least 500 milliseconds, with at most 6 screen pixels of movement when it begins on an annotation or 10 screen pixels on empty canvas
- `Shift+F10` while the canvas input surface has focus

The single transparent input surface converts the invocation point to page coordinates and resolves an annotation through the spatial index. A mouse right-click or touch long press on an unselected annotation selects only that annotation before opening the menu. Invoking it on an already selected annotation preserves the complete selection. Invoking it on empty canvas preserves the current selection. Selection caused by menu invocation is not a history entry and does not dirty the file.

Moving beyond the long-press threshold, receiving a second touch, starting a pen gesture, losing the owning presentation, or cancelling the pointer prevents the touch menu from opening. A long press on an annotation always selects and opens the selection menu regardless of the active tool; it never starts that tool's gesture. Dismissing a touch-opened menu does not restore focus through the disappearing menu onto the canvas. The keyboard menu is positioned at the visible selection center, or at the visible canvas center when no selection exists. Mouse, pen, and touch menus snapshot their invocation point, which also becomes the exact Context-menu Paste position.

When a selection exists, the menu begins with:

1. Copy
2. Cut
3. Paste, when `Clipboard.read()` is supported or a validated in-session payload is available
4. a separator
5. Delete
6. a separator
7. Bring forward
8. Send backward
9. Bring to front
10. Send to back

The canvas section follows after a separator:

1. Copy embed
2. Erase all
3. Delete embed

Without a selection, the selection section is omitted and Paste precedes the canvas section when `Clipboard.read()` is supported or a validated in-session payload is available. This action availability does not inspect system clipboard contents or permission. The four Arrange actions remain flat entries, preserving the existing menu structure. Disabled boundary actions remain visible. Delete removes only the selected annotations with one undoable canvas command. Erase all and Delete embed retain their confirmation behavior. Exact icons, destructive styling, focus behavior, and host API usage are defined in [Embed UI](embed-ui.md#context-menu-presentation) and [Obsidian Integration](obsidian-integration.md#commands-menus-icons-and-styling).

## Copying the Entire Embed

"Copy embed" in the overflow or context menu does not copy the individual strokes. It copies the embed's complete Markdown code.

When a copied embed is pasted, the plugin presents a choice:

- Reference existing file
- Make duplicate

Reference uses the same SVG file. Changes to one instance therefore also appear in the other.

Duplicate creates a new SVG file and verifies its readback against the validated source before replacing the file path in the pasted Markdown. Validation reuse follows the [host integration contract](obsidian-integration.md). Naming, placement, and collision behavior follow [Settings](settings.md) and the [Implementation Specification](specification.md).

## Importing from Obsidian Ink

The **Import** group in Settings offers **Start import**, with a description that identifies Obsidian Ink, and a default-collapsed **Import history** disclosure. **Start import** opens a local, explicit workflow for migrating supported Obsidian Ink handwriting into editable Inkbook files. Its assistant contains no history list. Inkbook does not scan at startup or contact a network service. Scanning changes no vault files; review the preview before choosing **Import handwriting**.

The workflow explains three steps: **1. Find handwriting** scans only supported handwriting sources referenced by notes; **2. Review the results** presents the convertible files, affected notes, warnings, and skipped items; **3. Switch the embeds** creates Inkbook copies and updates recognized note references. The entry explains this sequence, and the scan, preview, and import views identify their current step as 1, 2, and 3 respectively. A scan never changes files.

Before **Scan vault**, the introduction shows three real before-and-after examples from official Obsidian Ink: a diagram with visibly different curved wedges, print handwriting, and cursive handwriting. Each example names possible differences in pressure, stroke weight, smoothing, fine details, or background spacing. The examples are illustrative captures, not previews of the user's files. They are embedded locally and require no network request or vault read. Only the current pair of images is mounted; compact Previous/Next controls retain focus and announce the selected example. Comparisons are side by side on wide screens and stacked at the shared 480-pixel phone breakpoint. Captured PNGs retain their original pixels and proportions; centered cropping of empty paper margins fills equal 2:1 stages without letterboxing or clipping handwriting. Update the after-captures when material converter changes would make these examples misleading. The examples do not trigger scanning, conversion, or cleanup.

The scan recognizes official Ink handwriting references in Markdown and resolves their source files through Obsidian. Supported sources are legacy `.writing` files containing a tldraw snapshot, official handwriting SVGs containing tldraw metadata, and native InkCanvas snapshots at versions 1, 2, and 3. The SVG artwork is not mounted or trusted as the imported drawing: the importer reads the editable source metadata, converts supported strokes and shapes to native Inkbook elements, and validates the result against the existing Inkbook document schema. It does not introduce a new Inkbook file schema. Unsupported or invalid sources and unresolved references are reported and left unchanged.

The preview summarizes convertible handwriting files and affected notes with a plain text summary and a concise note that local copies and recovery backups use additional vault and sync storage. The entry explains that originals are retained; the preview does not repeat that explanation in a separate card. All convertible files start selected. Each file has a checkbox, and **Select all** applies to the complete scan across pages. The control reflects a mixed selection as indeterminate, and the import action is disabled when no files are selected. The affected-note count reflects references to the selected sources. Selection and the scan findings remain separate: changing selection updates the selected-file and affected-note counts without changing or regrouping the findings.

File rows show the source filename, full source path, and full Inkbook target path; file rows are paged at 25. Findings appear in three separate disclosures: **Appearance differences**, **Warnings**, and **Skipped items**; empty categories are omitted. Each category reports scan findings independently of selection. Identical messages are shown once, with their affected source and note paths grouped as origins where those paths are known, instead of repeating the message for every file. Origin lists use pages of 25 entries, with short lists shown inline, so large scans do not produce a wall of repeated text. Local-processing, backup-storage, and scan-limit information remains visible in the preview. Import applies only the selected sources and the associated note hashes; unchecked sources and their references remain unchanged. Import creates a new sibling named `<stem>.inkbook.svg`; if that path is occupied, it tries `<stem>.inkbook-1.svg`, then increasing numeric suffixes. It preserves the original source and replaces only recognized references for the selected sources in notes. Source files and original note contents receive separate verified backups, and a durable journal records each operation under `inkbook-imports/<run-id>/`. These backups use additional vault storage and may be included in vault-provider sync. This selection workflow does not change the Inkbook file schema.

Before writing each note, import resolves its original references again and requires their destinations to match the selected source paths from the preview. If a newly created or moved file changes a destination, the note remains unchanged and the journal records a conflict; verified Inkbook copies and backups remain available.

A note that exactly matches its verified original backup does not block recovery of other notes merely because its original basename link now resolves elsewhere. Recovery validates its historical source path lexically while retaining the backup, replacement, and context checks. This also keeps repeated undo safe after the original note has already been restored; changed notes retain the strict resolution check.

The import workflow uses the shared `InkbookMotionModal` and settings-shell appearance, with an 840-pixel desktop/tablet width for legible before-and-after examples and the available-height phone variant. The body owns scrolling while the heading and action footer remain visible. Import dialogs use the host medium UI type size, 32-pixel wide-screen content insets and 16-pixel insets at the shared 480-pixel phone breakpoint. Review explains how to select files and inspect differences before importing. Scan status uses a decorative paper, handwriting, and scan beam; it does not show measured progress or delay completion to finish the animation. Scan explains that files remain unchanged. Scan, import, undo, and cleanup retain a safe Stop action. Each workflow step exposes its own actions instead of combining scan, history, close, import, and recovery controls.

Some source appearance details, including brush width, background, and pressure behavior, may not map exactly to Inkbook and are reported as warnings. Canvas strokes first reconstruct source curve sections: the official profile accounts for source streamline and sharp-turn boundaries, while custom constant-width strokes follow their quadratic midpoint curve. Custom pressure strokes use an independently implemented approximation. Pressure-enabled Canvas pens translate the source nib diameter, including signed thinning and pen/mouse easing, into native pressure before quadratic curve interpolation. The importer chooses the native width preset with the smallest maximum clipping error across that stroke's source diameter range; ties select the smaller preset. A source range outside the selected pen's representable widths is clamped with an explicit warning. Constant-width pens and highlighters retain their existing behavior. Conversion adaptively samples those sections and checks the resulting native filtered centerline, preserving source roundings as well as sharp turns. It does not treat every saved control point as a hard corner. The result consists of ordinary editable Inkbook strokes; the native smoothing setting, renderer, and file schema remain unchanged. Expansion checks the per-stroke and remaining document point capacity before appending points and fails for capacity rather than silently dropping geometry. The source renderer can also widen filled contours through independent side smoothing; these geometric wedges are not reproduced by nib-pressure translation alone. Custom pressure preparation, short source strokes, and rasterized appearance remain approximations rather than pixel-equivalence guarantees.

Review the converted files before considering cleanup. Original files remain in place unless cleanup is explicitly chosen from import history. Cleanup considers only originals recorded by that import, verifies their backup and unchanged content, checks for references again, and moves eligible files to Obsidian trash. It never removes the journal or backups; cleanup does not promise to reclaim the storage used by the import records.

Cleanup retries replace each checked original's previous cleanup warning with its current result rather than accumulating duplicate or obsolete reasons. Unchecked originals retain their warnings after Stop. Successful cleanup clears that original's cleanup warnings; completed undo clears the run's cleanup warnings. Other import issues remain available, and loading history also removes duplicate cleanup warnings saved by earlier versions.

Import history is loaded only when its Settings disclosure is expanded. It shows localized run dates and readable statuses, with at most 25 runs per page. Empty history, loading, and retryable load-failure states are provided. Selecting a run opens its details and available recovery actions directly in the existing dialog; closing an import, undo, or cleanup dialog refreshes history when the disclosure remains expanded. Busy recovery operations expose only a safe stop action. Undo uses the journal to reverse only uniquely identifiable imported note references, preserving later note edits and reporting ambiguous or changed content as conflicts. It can restore an original previously moved to trash by this importer from its verified backup, provided the original path is still free; it does not overwrite a file created there later. For a missing original, journal evidence uses the recorded source path rather than rejecting a basename that temporarily resolves to another file. After restoring verified originals, undo resolves the original note references again; a reference that still points to a different file remains an Inkbook embed and is reported as a conflict. Converted targets or other files changed after import are not overwritten. Backups and history remain available after undo.

After import, the result separates the durable outcome, the next step, and recovery guidance. A finite decorative check animation confirms only a complete operation without conflicts or recorded issues; stopped or incomplete outcomes use an attention symbol and explicit review guidance. A successful restore additionally requires the durable `undone` journal status. The import result offers a lazy, 25-item paged list of applied notes to review; conflict notes remain in the issue flow. It explains that the user should close settings, open an affected note and check its converted handwriting before removing originals. Restore results explain that original SVGs retain their own appearance. Cleanup reports remaining originals explicitly. Counts, headings, actions and focus never wait for the animation. Undo and original-file cleanup are available through **Settings > Inkbook > Import > Import history**.

Undo issues name the affected note and explain whether an imported embed or its context changed, an original file could not be safely restored, the original link resolves differently, or reading/writing failed. The result and saved import details reuse the paged Issues list for these reasons, including when only part of a note could be restored. Retrying the same conflict does not add duplicate issues; each conflicted note is counted once alongside other independent issues. A successful retry clears that note's resolved undo issues. Recovery backups remain available for review.

Before undo or cleanup changes note references or original files, every original note backup must be readable and match its recorded content hash. A missing or unreadable backup and a changed backup have distinct recovery messages naming the note and backup paths. The user must restore the exact original backup from a trusted vault backup or sync history before retrying; replacing it with the current note or editing the import record is not a bypass. Unknown operation failures retain generic guidance without exposing internal exception details.

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

Pen-tap detection runs in the capture phase on the public CodeMirror editor container, including its scroll padding. A tap in that padding resolves through CodeMirror coordinates to the final line and inserts only if that line is eligible; it never creates a missing empty line. Native scrollbars, gutters, and existing widgets remain outside this insertion boundary. Accepted pointer events and the trailing click are consumed before host focus activation, so mobile insertion does not briefly open the software keyboard. Unrelated mouse, touch, and keyboard activation retain their normal behavior.

On success:

1. The plugin creates a new handwriting SVG file.
2. The registered **Insert handwriting embed** command inserts the custom `!inkbook` embed Markdown. It replaces the contiguous run of empty lines containing the target with exactly two empty lines above the embed and one below, adding missing lines and removing excess empty lines. This also applies at the start or end of a note. Non-empty neighboring lines remain unchanged. The syntax references the SVG through a normal link but never creates a native Obsidian image embed.
3. The next mounted embed editor is activated automatically.
4. After the widget is mounted and measured on two consecutive animation frames, the new embed opens in editing mode. If this does not happen within two seconds, insertion remains intact and retryable shared feedback is shown over the active view or owning window.
5. Shared success feedback with an icon-only Undo action remains visible for five seconds.

Undo restores the original empty-line run and removes the newly created file only if the inserted block and its spacing remain unchanged. The file is deleted through `FileManager.trashFile()` and therefore follows the user's Obsidian trash preference.

As soon as the first stroke is saved, the Undo feedback disappears automatically. If the feedback merely expires, the empty embed remains.

## Lock

The Lock button ends editing.

The process:

1. Input is disabled immediately.
2. The toolbar fades out.
3. A zoomed-in embed begins returning to width fit.
4. The camera and height animate toward width fit and the locked preview height over 240 milliseconds while the snapshot export and save run concurrently.
5. If saving is still running after the layout transition, the editor remains visible but disabled at the locked geometry.
6. After the exact saved revision and its static preview are ready, the complete persisted preview is restored below the disabled editor.
7. After one complete paint opportunity, preview and editor visibility exchange atomically, then the interactive editor is unmounted, as described in [Embed UI](embed-ui.md#locked-state).

The save is awaited in full so that the new preview does not accidentally load the previous file state. A validated saved SVG and the aspect ratio derived from those exact SVG bytes are mounted atomically, including when the presentation is already locked. A failed save keeps the disabled editor mounted with its dirty state and presents Retry, Save local copy, and Cancel actions. Cancel restores the prior active camera and active height without discarding data.

## Overflow Functions

The following functions are particularly relevant for the handwriting embed:

- Copy embed
- Erase all
- Delete embed

Erase all first displays a confirmation and then removes all canvas elements through an undoable command.

Delete embed checks whether the same SVG file is still referenced in other notes.

After confirmation, deletion removes the complete embed line and at most one immediately adjacent blank line above and below it. Whitespace-only lines count as blank. Any additional blank lines and all neighboring content remain intact. The same rule applies in Live Preview and Reading view, including at the start or end of a note.

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
