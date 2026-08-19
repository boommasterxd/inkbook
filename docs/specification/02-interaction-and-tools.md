# Interaction and Tools

## 1. Input Routing Invariants

Input ownership MUST be decided before a gesture mutates state.

1. A touch that begins on a plugin-owned visible element or its explicit handle MUST select or manipulate that element, regardless of the currently active tool.
2. A lasso MUST select only plugin-owned sidecar elements. It MUST NOT select, modify, or reinterpret Obsidian text.
3. An unclaimed one-finger touch on empty note content MUST remain available to Obsidian for native scrolling.
4. A two-finger pinch that begins within the note surface is claimed only after a calibrated distance-change slop proves pinch intent. It then controls plugin whole-note zoom around the pinch focal point while preserving operating-system accessibility gestures.
5. A stylus gesture on empty note content MAY be claimed by the active pen, highlighter, eraser, shape, line, or construction tool.
6. A mouse or stylus click selects an existing plugin element only in Cursor or Lasso mode, except when an explicit visible handle is activated. In Cursor mode, a frozen plugin-element or handle hit selects that annotation, while an unclaimed Markdown hit remains native text interaction.
7. Native Markdown caret placement, text selection, typing, IME, and software-keyboard input MUST remain available in Cursor mode. Cursor is simultaneously the native text tool and the annotation selection tool; Inkbook MUST NOT require a mode switch between those two actions.
8. The plugin MUST call `preventDefault()` or stop propagation only after it has claimed the specific gesture.
9. Pointer capture MUST be released on pointer up, cancellation, view disposal, and plugin unload.
10. Secondary-button routing MUST distinguish a stationary context-menu request from a drag before claiming either interaction.

Touch selection has priority over a drawing tool when the initial hit target is an existing plugin element. This prevents accidental overdraw on phones and tablets.

### 1.1 Input Gesture Profile V1

```ts
export const INPUT_GESTURE_PROFILE_V1 = {
  pinchDistanceSlopScreenPx: 8,
  longPressDelayMs: 500,
  longPressMovementSlopScreenPx: 8,
  secondaryButtonPanSlopScreenPx: 8,
  attachmentPortSnapScreenPx: 12,
  keyboardNudgeNotePx: 1,
  keyboardNudgeWithShiftNotePx: 10,
} as const;
export type InputGestureProfileV1 = typeof INPUT_GESTURE_PROFILE_V1;
```

`InputGestureProfileV1` is fixed product behavior, not a user setting. Pinch intent is recognized when the absolute change between the initial and current two-pointer distance reaches 8 screen CSS pixels. A plugin-target long press is recognized after 500 ms only while movement remains below 8 screen CSS pixels, no third pointer appears, and native text selection or an operating-system accessibility gesture has not claimed the sequence. Reaching the movement threshold, `pointerup`, `pointercancel`, `lostpointercapture`, a third pointer, successful long-press dispatch, ownership transfer to the host, view disposal, or plugin unload cancels the timer idempotently. Long press is available only on a frozen plugin-owned target and never suppresses a native long press on Markdown or empty note content.

### 1.2 Secondary-Button Routing

On secondary-button pointer down, the adapter snapshots the pointer ID, client coordinates, initial hit classification, whole-note zoom state, and current clamped pan ranges. It enters `menu-pending` without preventing default, stopping propagation, capturing the pointer, changing selection, or mutating state.

A stationary secondary-button click on native Markdown or empty note content MUST remain native so Obsidian can open its context menu. A stationary secondary-button click on a plugin-owned element or handle MUST suppress the native menu and open the applicable Inkbook annotation context menu. The routing decision uses the frozen initial hit classification even if the DOM below the pointer changes before `contextmenu` dispatch.

A secondary-button drag claims whole-note panning only when the zoom percentage differs from 100 percent, at least one clamped pan range is non-zero, and the inclusive Euclidean screen-space displacement reaches 8 CSS pixels. The threshold is evaluated as `dx * dx + dy * dy >= 64` using client coordinates. Before that threshold is reached, Inkbook MUST NOT prevent default or stop propagation.

After the pan threshold is reached, the adapter prevents the pending context menu, stops propagation, captures the pointer, and pans the shared Markdown, background, overlay, selection, and hit-test surface together. A claimed pan never opens either context menu, selects or edits an annotation, publishes an annotation operation, creates a host-history effect, or writes the sidecar. Pointer up, pointer cancellation, view disposal, and plugin unload release capture and return the recognizer to `idle`.

Secondary-button pan is an optional pointer shortcut, never the only navigation path. Native scrolling, touch scrolling, and host keyboard scrolling remain available, and panning does not move focus or add inertial animation when reduced motion is requested.

## 2. Tool Set

### 2.1 Primary Tools

The production toolbar MUST expose these tools directly in a validated user-configured order. The canonical default order is:

- Cursor;
- Lasso;
- Pen;
- Highlighter;
- Eraser;
- Rectangle;
- Arrow.

### 2.2 Secondary Tools

The More Tools menu MUST expose these tools in a validated user-configured order. The canonical default order is:

- Line highlighter;
- Ellipse;
- Triangle;
- Diamond;
- Octagon;
- Line;
- Coordinate system;
- Table.

The primary and More Tools group memberships are fixed. `Coordinate system` is one tool; its contextual stylebar selects 2D or 3D construction for the next element. Users MAY reorder tools within either group through Obsidian's normal plugin settings, but MUST NOT move tools between groups, omit tools, or duplicate tools. The More Tools menu MUST preserve the configured order. Recent-tool promotion MUST NOT reorder, hide, or replace a configured tool. Undo, Redo, Background, Zoom, and Settings are fixed utility controls and are not members of the configurable tool order.

### 2.3 Tool-Specific Behavior

- Pen creates a pressure-aware stroke when pressure is enabled at gesture start. The pressure choice is snapshotted for the gesture.
- Highlighter uses a constant visual width, translucent color, and multiply-like visual ordering below opaque pen strokes where the host renderer supports it.
- Line highlighter is an input shortcut that produces the same Highlighter element, style, and canonical geometry as the straight-line Highlighter variant. It does not imply an underline or any other text binding. Binding inference MUST NOT receive or persist the originating toolbar control.
- Eraser defaults to whole-element deletion. A future split-stroke mode is permitted only after it preserves undo, anchors, selection, and compact persistence.
- Shapes support a constant outline width during resize, optional fill, independently configurable outline and fill opacity, and solid, dashed, or dotted outlines.
- Lines and arrows support independently configured start and end caps. A selected Line or Arrow can be curved by dragging its center curve handle. Moving an endpoint changes line geometry without changing line width, cap size, dash pattern, opacity, or color.
- A Line or Arrow endpoint may remain free or attach to a stable port on an attachable plugin-owned object. An attached endpoint follows target move, resize, rotation, and view-local text reflow through reverse-indexed port resolution. Lines and Arrows attach neither to arbitrary DOM nodes nor to other Lines or Arrows, and attachment is independent from Group membership. V1 defines no separate attachment tool or relationship element kind.
- A Table gesture defines one initially unrotated rectangular frame. Pointer down and pointer up are opposite corners, the midpoint is the canonical center, and the absolute coordinate differences are the width and height. A width or height below 2 note CSS pixels cancels without publication. Bounded row and column counts initially subdivide the local frame into equal cells. The whole Table may then move, resize, and rotate as one element. Each internal row or column divider may be dragged along only its local perpendicular axis, remains strictly between its neighboring dividers or outer edges, and changes only the two adjacent track sizes. It never becomes a separate Line element.
- For an axes gesture, pointer down defines the origin and the drag vector defines the positive X-axis vector. `AxesConstructionProfileV1` derives the initial Y-axis by rotating that vector counterclockwise by 90 degrees for 2D axes. For 3D axes it derives the initial Y- and Z-axis vectors by counterclockwise rotations of 120 and 240 degrees. All initial vectors have the drag-vector length. A zero-length drag cancels without publication. Each selected axis exposes its own constrained positive-end length handle. Dragging that handle projects movement onto the existing axis ray and changes only its positive length. The shared origin, axis direction, and angle to every other axis remain unchanged. Both axes kinds may use a bounded grid density.
- Axes and Tables are one plugin-owned vector element each. Their derived cells and grid guides are not selectable or persisted as separate elements. They contain no Markdown text editor, cell editor, label, plugin-owned text box, camera, or 3D scene.

Tables and axes use the same preview, hit-testing, selection, lasso, move, rigid rotation, style, clipboard, context-menu, persistence, and one-operation undo contracts as other construction elements. A Table additionally supports whole-object area resize and constrained divider movement. Axes support independent constrained axis-length edits instead of whole-object area resize. Table outer borders and dividers, axes, axis guides, and positive-end caps retain their exact stored line widths and cap sizes in note units. Changing Table track count, divider positions, axis length, axis grid density, or construction style publishes exactly one reversible annotation operation. Axes never infer highlight or underline presentation. A Table may infer enclosure only when its outer closed frame passes the normal enclosure thresholds; otherwise Tables and axes use the normal `Text position` or `Fixed` fallback.

```ts
export const AXES_CONSTRUCTION_PROFILE_V1 = {
  twoDimensionalYDegrees: 90,
  threeDimensionalYDegrees: 120,
  threeDimensionalZDegrees: 240,
} as const;
export type AxesConstructionProfileV1 = typeof AXES_CONSTRUCTION_PROFILE_V1;
```

Angles are visually counterclockwise from the positive X vector in the CSS note plane, whose Y coordinate grows downward. For `theta` in radians, the exact rotation is `(x * cos(theta) + y * sin(theta), -x * sin(theta) + y * cos(theta))`. `AxesConstructionProfileV1` is fixed product behavior, not a setting.

A free or attached Line or Arrow endpoint may be dragged. At pointer release, a valid visible port whose screen-space center is within 12 CSS pixels is eligible; the boundary is inclusive. The nearest eligible port wins, then the frontmost canonical object-order position, then port order `area:north`, `area:east`, `area:south`, `area:west`, `axes:origin`, `axes:x-positive`, `axes:y-positive`, `axes:z-positive`. If no port qualifies, the endpoint becomes free at the released note point. Detach inverse-projects the currently visible endpoint through the Line or Arrow's own current binding before persisting its fallback, so the endpoint does not jump or receive the element offset twice. Preview never changes attachment authority. Commit replaces endpoint geometry and attachment in one reversible operation, and Escape or pointer cancellation restores both exactly. A stale or non-invertible projection rejects the commit.

Reconnect from the Line or Arrow stylebar or context menu enters a bounded port-pick mode over current viewport candidates. Port candidates use the same ordering, expose target kind and port in their accessible name, support next and previous navigation, Enter to commit, and Escape to cancel. `Detach` converts the endpoint to its current safely resolved fallback point. Pointer and keyboard paths share the same validation, reverse-index, recovery, history, and atomic publication contract.

While the Table tool is active with no Table selected, the contextual stylebar exposes bounded `Rows` and `Columns` defaults from 1 through 200 for the next Table. When an existing Table is selected, those same labelled controls read that Table's current canonical track counts and modify the selected Table itself, not the creation defaults. Changing one selected count replaces only that dimension's divider sequence with equal tracks and preserves the other dimension's custom divider positions. The operation immediately redraws the same Table and retains its element ID, frame, rotation, binding, z-order, and style as one reversible operation.

### 2.4 Automatic Binding Inference

Binding is inferred after geometry creation and MUST NOT be represented by additional drawing tools. The same Pen, Highlighter, Line highlighter, Line, Rectangle, Ellipse, and other construction tools create the same canonical element types whether the resulting binding is `Text range`, `Text position`, or `Fixed`.

The binding engine uses the deterministic profile in [Anchors and Layout](05-anchors-and-layout.md). Observable behavior is:

- a Highlighter whose path sufficiently overlaps one contiguous rendered text range receives `Text range` with highlight presentation;
- a straight Line with no curve control, or a Line highlighter sufficiently aligned with and close below a text baseline, receives `Text range` with underline presentation;
- a closed construction shape sufficiently enclosing text receives `Text range` with region presentation;
- a freehand element near text without qualifying range or enclosure evidence receives `Text position` and preserves its rigid geometry;
- an element without a safe nearby text target receives `Fixed`.

Straightness alone never turns a line or stroke into an underline. Closure alone never turns a freehand loop into a text enclosure. The complete overlap, proximity, source-continuity, and confidence rules MUST pass against the captured layout snapshot.

Inference runs once for a completed creation gesture or an explicit rebind request. It MUST NOT run during resize, rotation, pointer movement, scroll, pure note zoom, or every layout frame. Later reflow reprojects the stored binding but does not reclassify it. Moving a non-fixed element to a new destination performs a new inference as part of the same atomic transform-and-rebind operation; moving a fixed element preserves its binding.

The plugin MUST provide a short, non-modal indication of the inferred binding. A user correction changes only the binding and projection, not the drawing tool, canonical element kind, or visual style. One correction produces one reversible operation.

## 3. Selection and Manipulation

Cursor selection MUST support single selection, modifier-assisted additive selection, and selection through touch.

Keyboard-only users MUST be able to invoke `Select next annotation` and `Select previous annotation`. The commands use a cached deterministic selectable order derived once per scene revision from canonical object order. Every top-level Group root occupies the position of its earliest descendant and replaces all of its descendants regardless of current selection. The selection summary exposes an accessible `Enter group` action. While inside a Group, next and previous traverse its ordered direct children, nested Group roots replace their descendants by the same rule, and Escape returns to the parent Group root. At the first or last available item the unavailable direction is reported without wrapping or mutation. Selection reveals the current projection through the originating host view, moves focus to the accessible selection summary and actions, and MUST NOT scan the complete scene, mount all offscreen SVG, or require prior annotation focus.

Lasso selection MUST use actual plugin geometry or a single documented coverage threshold. The initial threshold is intersection with the lasso polygon for strokes and at least 50 percent covered area for filled or bounded construction objects.

Selection chrome is derived per view from canonical geometry and MUST use the following closed models:

- `linear`: a single Line or Arrow exposes start and end endpoint handles, its center curve handle, and attachment state at each attached endpoint. It has no rectangular resize frame.
- `area`: a single Pen stroke, Highlighter stroke, closed shape, or Table exposes one oriented rectangular frame derived from canonical geometry. Closed shapes and Tables use their stored `rotationRadians`; Pen and Highlighter use their stored `selectionRotationRadians`. A newly created stroke starts at zero orientation. A `fixed` or `text-position` Pen or Highlighter uses its sample bounds in that stored local orientation and exposes four corner handles, four edge handles, and one rotate handle. Every `text-range` element whose visible geometry is derived from range fragments or an enclosure envelope remains selectable, but geometry resize and rotation are unavailable until the user chooses `Text position` or `Fixed`; this includes Pens, Highlighters, enclosing closed shapes, and enclosing Tables. The binding control identifies that restriction. Constant-width stroke preview may apply one width-preserving affine transform to the retained centerline path. Pressure-varying Pen preview instead transforms a bounded centerline or level-of-detail representation and regenerates its derived outline from unchanged pressure samples and style; it MUST NOT scale the filled outline. Commit materializes the transform into sample coordinates. A zero-extent sample axis is expanded only for visible control chrome and cannot be scaled on that axis. Corner resize changes two available dimensions, edge resize changes one, and rotation is changed only by the rotate handle. A transformable Table additionally exposes one constrained handle for each internal row and column divider. Whole-table resize scales divider offsets with the local frame; divider drag changes only adjacent tracks and preserves the outer frame.
- `axis-set`: a single 2D or 3D axes object exposes one separate oriented linear control bound and one positive-end length handle for each axis, plus one shared rigid-move target and one rotate handle for the complete object. It has no common area-resize frame. A length handle changes one positive scalar length along the existing axis ray. Rigid rotation rotates every axis direction together about the unchanged origin, preserving all inter-axis angles and lengths.
- `aggregate`: a persisted Group exposes one rectangular frame in its stored `selectionRotationRadians`; a transient multi-selection begins with a zero-oriented frame around the union of member selection geometry. Each exposes one bounded handle set. Member-specific handles remain hidden until member editing or single selection. If the aggregate contains any `text-range` element whose visible geometry is derived from range fragments or an enclosure envelope, geometry resize and rotation are unavailable for the complete aggregate and the binding control identifies the blocking members. A pressure-varying Pen with `fixed` or `text-position` binding does not block an otherwise valid aggregate resize: its canonical centerline samples are transformed with the other members, while its filled outline is regenerated from unchanged pressure and style instead of being scaled. No partial member transform is permitted.

Every applicable model also exposes one anchor handle and anchor-status affordance. Selection-frame DOM and handles are view-local and MUST NOT be persisted. The canonical orientation fields that reproduce an area element or persisted Group frame after re-selection are scene data and MUST be persisted.

Pointer area resize resolves the pointer through the current note and inverse object-rotation matrices. The opposite corner or edge remains fixed in the object's local frame. A corner changes both dimensions and an edge changes only its perpendicular dimension; the replacement center is the midpoint of the fixed and moved local limits. Handles cannot cross their fixed opposite. Closed shapes clamp each dimension to at least `0.01` note pixel. For each Table resize axis, let `E` be the prior extent and `m` the prior minimum track size on that axis. The minimum replacement extent is `max(2, 0.01 * E / m)` note pixels, which guarantees every proportionally scaled track remains at least `0.01`. A value below the applicable minimum remains a preview at the minimum and commits that clamped geometry. V1 defines no pointer modifier for center-based or aspect-locked resize. Stroke and aggregate area resize apply the corresponding affine mapping from prior bounds to replacement bounds, with a zero-extent axis disabled as specified below.

```ts
export const ROTATION_SNAP_PROFILE_V1 = {
  intervalRadians: Math.PI / 2,
  thresholdRadians: Math.PI / 36,
} as const;
export type RotationSnapProfileV1 = typeof ROTATION_SNAP_PROFILE_V1;
```

The rotate handle keeps canonical center fixed. With note-space pointer `p` and center `c`, its raw visual counterclockwise angle is `atan2(-(p.y - c.y), p.x - c.x)` plus the captured grab offset. Let `q = round(raw / (Math.PI / 2)) * (Math.PI / 2)`. When the shortest angular distance from `raw` to `q` is at most `Math.PI / 36`, inclusive, preview and commit use `q`; otherwise they use `raw`. The chosen angle is canonicalized to `[-Math.PI, Math.PI)`, so snapping is absolute at 0, 90, 180, and 270 degrees rather than relative to the gesture start. Shape, Table, stroke, persisted Group, and permitted aggregate rotation use that definition. An aggregate containing axes uses the same one rigid angle for every member. Table divider offsets rotate only through the Table frame and do not receive separate coordinate rewrites.

For an `axis-set`, the absolute object angle is the visual counterclockwise angle of its positive X-axis vector, `atan2(-xAxis.y, xAxis.x)`. Rotation preview computes one delta from that captured angle to the snapped or unsnapped replacement angle and applies the same delta to every stored axis vector. This preserves all lengths and inter-axis angles. Reselecting derives the identical angle from the persisted X-axis vector; no additional orientation field is required.

Every committed area-element angle is stored in its canonical geometry, and every committed persisted-Group angle is stored in its Group record. Deselecting, closing selection UI, saving, reloading, Undo, or Redo MUST NOT reset that orientation. Re-selecting an object committed at 15 degrees therefore reconstructs a 15-degree frame; its next rotation still snaps only when the absolute angle enters the five-degree threshold around a quarter turn. A transient multi-selection has no persisted identity and therefore does not retain a frame angle after the selection is discarded.

Table-divider handles use one roving keyboard tab stop. Arrow navigation moves between dividers in stable row-then-column order before geometry editing begins. When screen-space hit regions overlap, the nearest actual divider wins; an exact tie uses that same stable order. The focused or pointer-targeted divider receives the full 44 by 44 CSS-pixel effective target without turning another divider into a separate selectable element.

At fixed whole-note zoom, every resize, divider, or endpoint operation MUST preserve stored line width, pressure values, outline width, Table border and divider width, axes and grid-guide width, cap size, dash pattern, stroke or outline opacity, fill opacity, color, and fill style exactly. It changes only canonical geometry and affected bounds. Editing geometry of any `text-position` element uses a current layout token, preserves the binding kind and source anchor, and recomputes only the local offset required by the projection equation in [Anchors and Layout](05-anchors-and-layout.md) when its canonical reference point changes. It performs no candidate search or binding classification. A stale or unresolved anchor cancels the operation without publication. A permitted group or multi-selection resize applies the geometric transform to all members as one atomic operation while preserving every member's style. When the selection contains a coordinate system, aggregate resize is constrained to one uniform positive scale so axis directions and inter-axis angles remain unchanged. Zero dimensions, a Table track smaller than 0.01 note CSS pixels, a non-positive axis length, non-finite geometry, or an axes result with a zero-length or collinear vector is rejected before publication.

Pointer movement renders a preview without publishing canonical state. Pointer up commits one reversible operation. Escape or pointer cancellation restores the exact pre-gesture state and creates no host-history effect.

Single-element geometry preview is `O(1)` apart from bounded path generation for that element. Pen and Highlighter preview MUST NOT rewrite canonical samples for every pointer event. A pressure-outline preview regenerates only the selected element's bounded current level of detail through the shared worker scheduler above the calibrated main-thread threshold; stale preview generations are discarded. Materialization of a long stroke at commit is worker-first and cancellable. An aggregate without visible pressure outlines uses one transient group transform. An aggregate containing pressure-varying Pens uses that transform for compatible members and one coalesced worker preview over only mounted pressure-stroke level-of-detail centerlines; it MUST NOT visit offscreen members or rewrite canonical samples for each pointer event. Commit transforms all affected immutable records and regenerates exact pressure outlines in cancellable worker chunks before one atomic publication. It updates only affected bounds, spatial-index entries, and geometry-dependent caches and MUST NOT rebuild the complete scene or spatial index.

Dragging the center curve handle of a Line or Arrow previews and commits an optional quadratic curve control point in canonical note coordinates. A missing control point denotes straight geometry. The interaction preserves endpoints, caps, dash style, element identity, and binding metadata unless a current-token binding validation changes that binding atomically. Curving a Line with underline presentation MUST revalidate the underline relationship within the same operation; an invalid curved underline falls back safely as defined in [Anchors and Layout](05-anchors-and-layout.md).

Keyboard manipulation MUST support 1 note-CSS-pixel movement and 10 pixels with Shift. Linear endpoints, area handles, Table-divider handles, per-axis length handles, aggregate handles, and rotate handles MUST have element-specific accessible names and keyboard equivalents. Enter commits a keyboard transform and Escape cancels it. Focus MUST return to the invoking handle.

## 4. Undo, Redo, and Clipboard

Every committed annotation gesture MUST produce exactly one reversible annotation operation. In a supported editable CM6 view it MUST also contribute exactly one isolated, invertible effect event to that concrete editor's existing host history without changing Markdown. Annotation undo and redo MUST preserve element IDs, z-order, bindings, anchors, geometry, and styles. Inkbook MUST NOT install a second CodeMirror history extension, replace Obsidian's history keymap, insert hidden Markdown, or maintain a competing annotation-only shortcut cursor.

The plugin MUST register Obsidian commands for cut, copy, paste, duplicate, delete selection, select all annotations, select next annotation, select previous annotation, open the annotation context menu, and every tool. It MUST NOT register annotation-only Undo or Redo commands as an alternative history path. Users configure bindings through Obsidian's Hotkeys settings, not through a custom shortcut editor.

`Mod+Z`, the platform redo shortcut, and the toolbar Undo and Redo controls MUST delegate to the same release-gated host-history adapter for the originating editable Markdown view. A native Markdown history event invokes the host history operation. An annotation effect intent applies its exact recovery-protected inverse or forward patch through one fresh current-revision dispatch in the shared `NoteSession`. A successful result updates every attached annotation projection but is not duplicated into another pane's host history. YAML marker updates, source checkpoints, sidecar saves, layout reflow, and pure zoom produce no history event.

Only the pane holding the current note session's annotation-history lease may create, transform, restyle, delete, undo, or redo annotations. Other panes keep native Markdown editing and current read-only annotation projection. They show why annotation controls are unavailable and cannot acquire a competing lease while the owner view and its actionable annotation effects remain alive. Owner disposal ends the history epoch only after pending intents settle or fail closed and the canonical scene is recovery-protected; a later pane starts a new epoch from that exact scene. An effect from an older epoch is stale and MUST NOT mutate the scene.

When an annotation element or handle owns focus, or a nonempty annotation selection is active outside native text editing, the usual `Mod+C`, `Mod+X`, `Mod+V`, Delete, and Select All commands act on annotations. Native Markdown editors, inputs, textareas, contenteditable regions, and Obsidian modals retain their native clipboard, selection, and local input-history behavior. Undo and Redo remain on the shared host-history path rather than switching to an annotation-only path. Commands remain available through the toolbar, context menu, and Command Palette. Tool shortcuts MUST avoid overriding Obsidian core bindings by default.

Clipboard data MUST use the bounded `InkbookClipboardV1` format in [Domain Model and Codecs](15-domain-model-and-codecs.md). The custom MIME payload is preferred and its plain-JSON fallback is accepted only after the same complete validation. Pasting allocates fresh IDs, preserves only internal copied Group and Line or Arrow endpoint-attachment relationships, re-infers destination bindings, and rejects the whole request before mutation on any invalid or over-limit record.

## 5. Context Menus

A target-specific Inkbook context menu MUST be available for plugin-owned annotation targets through stationary right click, touch long press, and Shift+F10. It MUST expose only actions valid for the target, including style, z-order, group, ungroup, duplicate, text binding, reconnect, and delete.

The context-menu handler MUST use the frozen initial hit classification. On a plugin-owned target it prevents the native menu and opens the Inkbook target menu. On native Markdown or empty note content it neither prevents default nor stops propagation, allowing Obsidian to open its native menu. While secondary-button pan is active it suppresses menu dispatch and opens no menu.

The production annotation menu MUST use Obsidian `Menu`. Pointer invocation uses `showAtMouseEvent()`. Shift+F10 and long-press invocation use `showAtPosition(position, ownerDocument)` with coordinates relative to the originating view's owner window. Inkbook MUST NOT replace the native Markdown context menu or attach a global document-level context-menu owner.

Context menus MUST implement initial focus, Arrow Up and Arrow Down navigation, Home, End, Escape, dismissal on outside activation, and reliable focus restoration.

## 6. Whole-Note Zoom

Zoom MUST scale native note content, the annotation overlay, hit targets, selection geometry, backgrounds, and anchor layout together. It MUST NOT maintain an independent SVG camera.

The supported range is 50 to 400 percent in 10 percent toolbar steps. Platform pinch gestures MAY produce intermediate values. The recognizer is scoped to the concrete note root and MUST be verified against Obsidian application zoom on desktop and Android during Phase 0. Visual stroke widths scale with the whole note because the user is zooming the complete document, while shape resize at a fixed document zoom MUST keep outline width constant.

Pointer coordinates MUST be converted through the same composed DOM transform used by the note content and overlay. Pure note zoom with unchanged logical note width MUST update only view and hit-test transforms. It MUST reuse existing layout-derived placement and MUST NOT trigger text layout, binding projection, classification, canonical publication, history, or sidecar work. A zoom event invalidates layout-derived placement only when the host also changes logical note width. Zoom never changes canonical stroke geometry.

## 7. Keyboard and Accessibility

Every toolbar, stylebar, menu, popover, selection handle, and context-menu action MUST be operable by keyboard and expose an accessible name. Tool toggles MUST expose their pressed state. Controls MUST have a minimum 44 by 44 CSS-pixel touch target in compact layouts.

The next and previous annotation commands provide the initial pointer-free path into an individual selection. Their explicit invocation announces position and element type, reveals the selected projection, moves focus to the selection summary, and exposes the same actions as pointer selection. Background scene updates and non-selection commands MUST NOT steal native text focus.

The toolbar MUST use roving focus or an equivalent predictable navigation model. Popovers MUST return focus to their invoker. Status changes such as sidecar conflict, unsaved annotations, unavailable overlay, or read-only newer format MUST be announced without stealing focus.

Motion MUST respect `prefers-reduced-motion`. Color MUST never be the only indicator of tool, selection, anchor, error, or save state.
