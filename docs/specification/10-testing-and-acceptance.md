# Testing and Acceptance

## 1. Test Layers

The test tree MUST mirror production package structure under `test/` and include:

- pure domain unit tests;
- seeded property, fuzz, mutation-sequence, and model-based state-machine tests for geometry, operations, codecs, anchors, parsers, sessions, history, persistence, and recovery;
- application integration tests for sessions, undo, save generations, conflicts, and recovery;
- capability-configurable fake-host contract tests for Obsidian Vault, workspace, editor, history, reading view, settings, lifecycle, pop-outs, and absent or malformed capabilities;
- deterministic browser simulation for toolbar, stylebar, SVG, pointer and touch routing, keyboard, IME, focus, accessibility tree, themes, media queries, and owner-window behavior;
- controlled worker, IndexedDB, Vault, scheduler, timer, animation-frame, idle-callback, and fault-injection integration tests;
- automated packaged-plugin tests on the declared desktop and Android host matrix wherever the host exposes a controllable runner;
- deterministic structural performance tests, simulated interaction timing, instrumented microbenchmarks, and automated calibrated host or device benchmarks where physical measurements are required.

Tests MUST assert observable contracts rather than incidental implementation details. They MUST be deterministic, independent, and free of fixed waits. Asynchronous suites use injected monotonic clocks and controlled event queues. Failed fuzz seeds and race schedules are replayable. Every automatable normative behavior uses an executable test; a written manual procedure is not an alternative.

Sections 2 through 8 are executable acceptance contracts, not recurring instructions for the user. Each scenario is implemented at the lowest faithful automated layer. Packaged-host, emulator, or device automation is added only when a fake or simulation cannot observe an implemented contract and a stable control surface exists. Normal test output and direct production-package inspection are sufficient records. The sole routine human activity is the one short phase-sanity scenario defined by the roadmap after all automation passes.

## 2. Product Acceptance Scenarios

### 2.1 Native Markdown

1. Open an unannotated `.md` note and verify a `ready`, `unowned`, `unannotated` session whose editable view derives mutable first-command eligibility while Reading View derives read-only access.
2. Type, select, format, undo, redo, invoke the software keyboard, and use Obsidian Properties normally in Cursor mode.
3. Verify that the plugin does not create a Markdown text box or custom renderer.
4. Verify that no sidecar is created until the first annotation command reaches its identity-bound `first-sidecar-pending` transition and the matching revalidated command performs the one permitted create-if-absent.
5. After an annotation exists, keep Cursor active, select that annotation by pointer and keyboard, then return focus to Markdown and type normally without changing tools. Verify that annotation selection never replaces native Obsidian text editing.

### 2.2 First Annotation

1. Select Pen, draw one stroke, and release.
2. Verify one scene operation, scene revision `1`, component revisions `1`, one isolated invertible host-history effect, one sidecar save generation, sidecar revision `1`, `baseRevision: null`, current Markdown source generation and digest, both YAML marker keys, and no empty revision-zero file or externally observable generic drift between marker acknowledgement and first-sidecar acknowledgement.
3. Inject cancellation, timeout, disposal, identity mismatch, create failure at a revalidated absent path, and a nonmatching command during `first-sidecar-pending`; verify no automatic replacement is created, acknowledged recovery remains, eligible failures become `marker present, sidecar missing` drift, and a nonmatching command is rejected without consuming the pending transition.
4. Inject a create-if-absent path collision and verify sidecar conflict without overwrite rather than a missing-sidecar state.
5. With the default policy, verify the sidecar is adjacent and named `<note-base>.inkbook.json`. With `vault-root: "Annotations"`, verify `Notes/Course.md` creates `Annotations/Notes/Course.inkbook.json`, writes that exact normalized locator to YAML, and creates no adjacent sidecar.
6. Reload the Vault and verify byte-stable visible geometry within the quantization tolerance.

### 2.3 Unified Undo and Redo

1. Type Markdown A, commit annotation B, and type Markdown C in one editable pane. Verify successive host Undo actions remove C, B, and A in that order and Redo restores A, B, and C.
2. Verify platform shortcuts and toolbar Undo and Redo produce the same host-history results from native text focus and annotation focus without an annotation-only command or shortcut cursor.
3. Verify one annotation operation creates one isolated invertible effect event, no Markdown change, one recovery-protected scene operation, and one save generation. Verify text typed before and after the event does not merge across it.
4. Create a new operation after Undo and verify the applicable host redo branch is discarded without retaining a competing annotation redo state.
5. Create an annotation event in pane A. Verify it is not duplicated into pane B's history, and successful Undo or Redo from A updates the shared canonical scene and both projections exactly once.
6. Attempt a conflicting annotation operation from pane B while pane A owns the annotation-history lease. Verify pane B remains a current read-only annotation projection, native Markdown editing still works there, and no second annotation effect or scene mutation occurs. Dispose A, settle the epoch, acquire a new epoch in B, and verify no effect from A can mutate B's epoch.
7. Deliver duplicate and out-of-order original-forward, inverse, and redo effects with explicit host transaction sequences. Delay a duplicate Forward until after Undo and a duplicate Inverse until after Redo. Verify equal sequences are idempotent retries, lower sequences are stale, only a greater lifecycle-valid sequence advances the state, and no delayed duplicate is interpreted as the next host transition.
8. Inject an absent bridge, unsupported editor engine, malformed host access, stale revision, view disposal, recovery failure, and rapid alternating Undo and Redo. Verify fail-closed annotation mutation, truthful retryable status, unchanged Markdown, no unprotected scene publication, and no fallback history interception.
9. Suspend the owner view's annotation projection under resource pressure, then invoke an actionable host Undo and Redo. Verify recovery and canonical publication complete exactly once through the pre-reserved emergency and completion capacity while the suspended projection receives only its latest revision token.

### 2.4 Touch Routing

1. Activate Pen on a phone or touch emulator.
2. Touch an existing shape and verify it becomes selected without a new stroke.
3. Touch and drag native Markdown and empty pass-through note content and verify native scroll, no prevented event, and no retained non-passive Inkbook move listener.
4. Place a second direct-touch contact before the host claims the sequence. Verify only its cancelable `touchstart` is prevented to reserve a potential pinch, with no propagation stop, zoom change, canonical mutation, history effect, or sidecar generation before intent is proven.
5. Move below, exactly at, and above the 8-CSS-pixel two-finger distance slop from `InputGestureProfileV1`. Verify no zoom below the threshold, then continuous current-sample plugin zoom while both contacts remain down at and above it, with no release-time jump. Verify an operating-system accessibility zoom gesture is not intercepted.
6. Repeat with a non-cancelable, already prevented, or otherwise host-owned second contact. Verify Inkbook yields the complete sequence and applies no delayed zoom when it ends. Add a third contact, cancel, dispose, and unload before and after claim and verify exact listener and gesture-state release.
7. Draw with a stylus and verify the gesture is claimed by Pen.
8. Right-click without dragging on native Markdown and empty note content and verify Obsidian's native context menu opens without an Inkbook selection or operation.
9. Right-click without dragging on a plugin element and verify the Inkbook target menu opens while the native context menu is suppressed.
10. At 100 percent zoom or with no available pan range, move the secondary button below, exactly at, and above 8 CSS pixels and verify Inkbook does not claim panning.
11. At non-100-percent zoom with an available pan range, move below 8 CSS pixels and verify no panning or premature event suppression.
12. Repeat at exactly and above 8 CSS pixels and verify the shared note surface pans with no context menu, selection change, annotation operation, host-history effect, or sidecar generation.
13. Start the claimed pan on an annotation and verify the annotation itself never moves.
14. Cancel, dispose, and unload during pending and active states and verify pointer capture, listeners, and pending menu state are released.
15. Release a short tap, lose pointer capture, add a third pointer, transfer ownership, dispatch successfully, dispose the view, and unload the plugin around the 500 ms boundary. Verify every path cancels the timer idempotently and no delayed menu opens.
16. At 50, 100, 175, and 400 percent whole-note zoom, drag one finger from native Markdown and empty pass-through content horizontally, vertically, and diagonally through every available scroll range. Verify native direction, momentum and clamping, synchronized Markdown, background, overlay, selection, and hit testing, zero Inkbook capture or one-contact non-passive listener, and no annotation selection, canonical publication, history, recovery, or sidecar work.
17. Repeat from an Inkbook element and each explicit handle. Verify the frozen plugin hit retains touch selection or manipulation priority and never becomes viewport pan. Repeat with one zero-range axis and verify only the available axis moves.

### 2.5 Lasso Isolation

1. Lasso across Markdown text and several plugin objects.
2. Verify only qualifying plugin objects are selected.
3. Verify native text selection, Markdown content, and editor history are unchanged.

### 2.6 Anchor Reflow

1. Draw beside paragraph B and verify a `Text position` binding is created.
2. Insert two paragraphs above B and trigger reflow.
3. Verify the annotation follows B without regenerating stroke geometry.
4. Move the annotation beside paragraph D and commit.
5. Verify a new binding at D, then undo and verify the exact prior transform and B binding.

### 2.7 Automatic Binding and Variable Width

1. Draw a broad Highlighter path over one contiguous text range and verify `Text range` with highlight presentation.
2. Repeat with the path immediately outside the documented overlap threshold and verify that it remains `Text position` or `Fixed`.
3. Draw a straight Line with no curve control within the baseline angle, distance, and overlap thresholds and verify `Text range` with underline presentation.
4. Draw an otherwise identical Line immediately beyond each threshold and verify that straightness alone does not create an underline.
5. Draw a rigid freehand annotation beside a paragraph and verify `Text position` with unchanged canonical samples.
6. Draw an Ellipse around multiple paragraphs and verify one ordered source range, enclosure presentation, captured margins, and a visible inferred-binding status.
7. Resize the pane from a wide desktop layout to a narrow phone layout so the paragraphs wrap differently. Verify that line fragments and the enclosing region follow the same source ranges, that the circular Ellipse may render as an ellipse, and that canonical element geometry does not change.
8. Open the same note in two panes with different widths and verify view-local projections from one canonical scene without persisted divergence.
9. Correct the selected element among `Text range`, `Text position`, and `Fixed`. Verify one operation, exact undo and redo, and no drawing-tool change.
10. Zoom the note without changing logical width and verify zero reclassification calls, history entries, canonical publications, or sidecar generations.
11. Supply stale, missing, ambiguous, and over-limit layout evidence. Verify no guessed range, no partial publication, and a truthful degraded or fallback status.
12. Verify that the toolbar contains no underline, text-highlight, or text-enclosure tool.
13. For each of highlight, underline, `Text position`, and `Fixed` outcomes, create identical straight Highlighter geometry and style once through Highlighter and once through Line highlighter. Excluding element IDs and operation metadata, verify identical classification and persisted element data with no originating-tool field.

Automated threshold tests MUST cover values immediately below, exactly at, and immediately above every distance, angle, overlap, closure, candidate-count, block-count, and source-span boundary in `BindingInferenceProfileV1`. Repeated classification with identical geometry, Markdown digest, and layout token MUST be byte-for-byte deterministic.

### 2.8 Background Alignment

For every theme in the finite release matrix, font setting, Live Preview, Source, phone width, and 50 to 400 percent zoom:

1. choose none, ruled, squared, and dotted backgrounds;
2. verify `none` creates no gradient or SVG background nodes and performs no background measurement or region work;
3. verify the exact `L`-based vertical period and stable block-scoped baseline phase from Anchors and Layout;
4. verify paragraphs, lists, blockquotes, and adjacent body-text blocks with different margin phases use one fallback underlay plus mutually non-overlapping override regions in note order, and every ordinary body-text baseline remains on its corresponding row;
5. verify compact, standard, and wide horizontal ratios of `0.75`, `1.00`, and `1.25`, one shared horizontal origin, and that ruled ignores the horizontal preset visually;
6. verify the exact clamped font-relative line width and dot diameter in every region;
7. verify phase stability while scrolling, virtualizing blocks, and using panes with different widths. In Reading View, verify the fallback remains owned by the whole-note view, each override has exactly one section child owner, detach and reprocessing remove or replace only that child's regions, no cross-owner merge occurs, and no duplicate region remains;
8. change theme, font size, line height, writing layout, and mode and verify atomic derived background and annotation realignment without sidecar geometry mutation;
9. make font metrics unavailable and verify only affected regions degrade visibly to `none` rather than using an arbitrary fallback;
10. verify the fallback layout-probe region for an empty note and uncovered visible note space;
11. verify pure zoom reuses unzoomed metrics and creates no region remeasurement per frame, history entry, canonical publication, or sidecar generation.
12. verify adjacent equivalent regions merge, values at the 512-region and 4,096-line-box limits succeed, immediately over-limit layouts degrade the complete affected background to `none`, and cancellable sliced derivation publishes no stale or partial generation.

Then switch each prepared case to Reading View and verify the read-only rendering remains aligned. Background selection itself is performed only in an editable view.

### 2.9 Toolbar and Stylebar

1. Operate every tool and style control with mouse, touch, keyboard, and screen reader.
2. Verify the stylebar opens below the toolbar and reflects tool defaults or selection state.
3. Verify mixed multi-selection styles are explicit.
4. switch Floating to Docked and verify no document or history mutation.
5. verify narrow layouts retain every command with 44-pixel targets and no hover dependency.
6. verify the `Text binding` radio group exposes `Text range`, `Text position`, `Fixed`, and `Mixed`, supports Arrow-key navigation, and remains directly operable by touch.
7. verify inference announcements do not steal focus and manual correction restores focus predictably.
8. load the canonical default tool order, then save and reload valid custom orders for both fixed groups.
9. verify every tool appears exactly once and that utilities never enter the configured order.
10. supply duplicate, missing, unknown, wrong-group, malformed, older-supported, and newer-unsupported order data and verify deterministic migration or safe default fallback with truthful status.
11. reorder with keyboard, touch, screen reader, and optional drag interaction; verify focus retention, position announcement, Reset to default, and 44-pixel compact targets.
12. verify all open panes update to the same plugin-global order without Markdown, sidecar, scene, selection, or history mutation.
13. verify narrow layouts preserve the configured order in the primary scroller and More Tools menu.
14. verify that every supported Markdown view mounts one toolbar host and one independent note-header Show or Hide toggle for its complete lifetime. Collapse and expand the visible toolbar repeatedly in `always`, `annotated-notes`, and `manual` modes; verify the same host, tool state, selection, stylebar state, focus context, subscriptions, and retained overlay remain alive without a React-root or SVG-root remount.
15. verify that the external toggle remains visible, keyboard reachable, screen-reader named, and at least 44 by 44 CSS pixels while the toolbar is collapsed. Its pressed or expanded state reflects actual visibility, and the Obsidian command changes only the originating view.
16. select every closed shape and set outline opacity and fill opacity independently at `0`, `0.01`, `0.99`, and `1`. Verify mixed selection state, immediate retained rendering, exact Undo and Redo, save and reopen, and no shared or multiplied group-opacity behavior.

### 2.10 Zoom

1. Zoom from 50 to 400 percent through controls and pinch.
2. Verify Markdown, SVG, selection, background, and hit testing remain aligned.
3. Resize a shape and Table, move a Table divider, and change one axis length at a fixed zoom. Verify every outline, border, divider, axis, grid guide, and cap width remains constant in note units.
4. Verify zoom does not add a host-history effect or alter canonical geometry.
5. With horizontal and vertical zoom overflow, pan left, right, up, down, and diagonally by native one-finger touch scrolling and by secondary-button drag. Verify both paths use the same clamped view transform and keep Markdown, background, overlay, selection, and hit testing aligned.
6. At every pan boundary and with either axis unavailable, verify exact clamping, no position drift after repeated zoom and pan cycles, view-local independent offsets in two panes, and zero canonical, Markdown, history, recovery, or sidecar mutation.

### 2.11 Lines, Tables, and Axes

1. Create a Line and an Arrow, select each, and verify the same center curve handle is available.
2. Curve each element and verify one quadratic control point, one reversible operation, correct hit-test bounds, unchanged endpoints, caps, dash style, identity, and outline width.
3. Cancel a curve preview through Escape and pointer cancellation and verify exact rollback with no host-history effect.
4. Curve a Line that has underline presentation and verify atomic fallback to the current safe `Text position` or `Fixed` binding; undo restores the exact straight underline and binding metadata.
5. Activate the one Coordinate system tool, select 2D and then 3D in its active-tool stylebar, and create one object of each kind. Verify the exact 90-degree and 120-/240-degree initial axis-vector derivations, one semantic element per object, persisted dimensionality, read-only dimension display after creation, and no separate 2D or 3D toolbar tool.
6. Create a Table and verify it is one selectable plugin-owned element with no Markdown editor, cell editor, label, camera, or per-cell, per-divider, or per-grid sidecar record. Verify its center, local dimensions, orientation, divider offsets, and rotation about its center.
7. Move, resize, rotate, restyle, lasso, duplicate, copy, paste, delete, and undo each construction element. Verify that whole-Table resize proportionally maps divider offsets but does not change stored border or divider width. Change each coordinate-system axis length independently and verify the shared origin, axis direction, every inter-axis angle, all other lengths, and axis, guide, and cap style remain unchanged.
8. Verify exact non-revision canonical geometry, including Table orientation canonicalization at `-Math.PI`, `Math.PI`, and immediately adjacent values, stable identity, binding, z-order, style, and inverse patch values after Undo and Redo while revisions remain monotonic.
9. Set the active Table tool's creation defaults, create a Table, then select it and change its `Rows` and `Columns` independently to 1 and 200 through the selection stylebar. Verify the selected controls display the object's current counts, redraw the existing Table immediately, and do not overwrite the creation defaults. Reject 0 and 201 before mutation. Verify that changing one selected dimension creates equal tracks only for that dimension, preserves the other dimension's custom divider offsets, and retains the same Table identity, frame, rotation, binding, z-order, and style. Test Table extents immediately below, exactly at, and immediately above the 2-note-pixel minimum.
10. Drag every Table divider through pointer and keyboard input. Verify movement is constrained to its local perpendicular axis, affects only adjacent tracks, cannot cross neighbors or violate the 0.01-note-pixel minimum, and remains one Table operation with exact cancellation and undo. At dense track counts, verify nearest-divider hit resolution, stable tie-breaking, roving focus, and a 44-pixel effective target for the active divider.
11. Verify axis grid divisions at 0, 1, and 64, the exact axis and pairwise guide endpoints, positive-end caps, fixed pair ordering, non-deduplication, and `2 * (N - 1)` or `6 * (N - 1)` guide counts. Reject 65, zero-length vectors, and pairwise-collinear vectors before mutation.
12. Verify note, viewport, and screen matrix round trips across zoom and pane widths for all three canonical construction kinds.
13. Verify axes never infer highlight or underline and a Table receives enclosure only when its outer frame passes the normal enclosure thresholds.
14. Verify maximum Table and axes rendering stays inside the DOM-node, path-command, spatial-index, cache, and frame budgets without one node per cell, divider, or grid guide.
15. Create Lines and Arrows with zero, one, and two attached endpoints. For Rectangle, Ellipse, Triangle, Diamond, Octagon, Table, 2D axes, and 3D axes, verify every permitted port lies on its exact current outline or semantic axis point. Verify snap candidates below, exactly at, and above the 12-CSS-pixel threshold, deterministic nearest-port selection, free placement outside the threshold, keyboard port choice, and exact Detach and Reconnect. Move, resize, rotate, and text-reflow each target; verify only reverse-indexed attached endpoints follow and that curves remain Lines or Arrows rather than becoming another element kind.

### 2.12 Selection Models and Constant-Width Resize

1. Select a Line and Arrow with free, singly attached, and doubly attached endpoint combinations. Verify start and end endpoint handles, attachment indicators, the curve handle, no rectangular area frame, geometry-aware hit testing, and an axis-aligned envelope used only for spatial-index broad phase.
2. Select single Pen and Highlighter strokes, every closed shape, and a rotated Table. Verify one geometry-derived oriented rectangular area frame whose visible angle equals the element's current canonical selection rotation, and verify agreement among preview, commit, hit testing, lasso, and rendered geometry. Verify that transformable `fixed` and `text-position` elements expose their applicable handles, while every `text-range` element derived from fragments or an enclosure envelope exposes no geometry resize or rotate handles and explains the required binding change. Cover range-bound Pens, Highlighters, closed shapes, and Tables. For each transformable stroke, verify unchanged pressure and style, current-token validation without reclassification, exact undo, and disabled scaling on a zero-extent sample axis. Verify width-preserving retained-centerline preview for constant-width strokes and regenerated bounded level-of-detail outlines, with no filled-outline scaling, for pressure-varying Pen strokes. Verify worker-first sample materialization at commit. For each transformable Table, also verify one constrained handle per internal divider and no separately selectable divider element.
3. Select 2D and 3D coordinate systems. Verify one line-like control corridor and positive-end length handle per axis, one shared move target, one rigid-rotation handle, no common area-resize frame, and unchanged axis directions and inter-axis angles during length editing.
4. Resize and rotate every transformable `fixed` and `text-position` Pen and Highlighter stroke, every bounded shape, and every Table; move every Table divider; and change every coordinate-system axis length at 50, 100, and 400 percent whole-note zoom. Verify changed geometry, byte-identical stored style and style revision, unchanged pressure values and note-unit line and cap widths, correct visual scaling from whole-note zoom, exact cancellation, undo, and redo, and no cumulative width or geometry drift after repeated cycles.
5. Move every linear endpoint at the same zoom values and verify unchanged line width, cap size, dash pattern, opacity, color, identity, and unaffected endpoint where applicable.
6. Resize a persisted Group and a transient mixed multi-selection whose members all permit the aggregate geometry transform. Verify one aggregate frame, hidden member-specific handles, one atomic commit, one host-history effect, per-member constant widths, stable group identity, and incremental affected-entry index updates. Add each kind of fragment- or enclosure-derived `text-range` element and verify resize and rotation become unavailable for the complete aggregate with no partial mutation. Separately add visible and offscreen pressure-varying Pens with transformable bindings. Verify a transient transform for compatible members, a single coalesced current worker preview only for mounted pressure-stroke level-of-detail outlines, no direct filled-outline scaling, no offscreen preview generation, exact pressure-outline regeneration at commit, and one width-preserving atomic operation.
7. Cancel every pointer and keyboard transform through Escape and pointer cancellation. Verify exact prior geometry, style, binding, selection, focus, and zero canonical publication, history entry, or sidecar generation.
8. Serialize the resulting scene and verify that no selection frame, handle, control bound, paint bound, index envelope, preview transform, or DOM-derived measurement is persisted.
9. Drag every area handle immediately before, at, and across its opposite limit and verify local-axis projection, fixed-opposite behavior, the shape `0.01` clamp, each Table axis clamp `max(2, 0.01 * priorExtent / priorMinimumTrack)`, no track below `0.01`, no handle flip, correct midpoint center, and no pointer modifier changing the contract. Rotate across `-Math.PI` and `Math.PI` and verify the exact visual-counterclockwise matrix and canonical `-Math.PI` result.
10. Rotate each transformable stroke, closed shape, Table, 2D or 3D coordinate system, and persisted Group to 15 degrees, deselect, reselect, save, reopen, Undo, and Redo. For axes, measure the angle from the positive X-axis vector. Verify the oriented selection controls and accessible angle retain exactly 15 degrees. Approach absolute `0`, `90`, `180`, and `270` degrees from both directions immediately below, exactly at, and immediately above the 5-degree snap threshold; verify only values within the inclusive threshold preview and commit the absolute quarter-turn while all other angles remain freely selectable and persistent. Verify transient mixed multi-selection orientation is not serialized.
11. Move one annotation, one persisted Group, and one transient multi-selection toward the top and bottom of the concrete scroll surface. For `B = min(48, 0.25 * H)`, place the captured pointer immediately outside, exactly at, and immediately inside each edge band and verify no autoscroll outside or at the boundary and the correct signed vertical autoscroll inside it.
12. With a deterministic frame clock, verify the exact quadratic penetration formula at `p = 0`, `0.5`, and `1`, the 1,200-screen-pixel-per-second maximum, the 32-ms frame-delta cap, current vertical-range clamping, and unchanged horizontal scroll. Repeat at 50, 100, 175, and 400 percent zoom and verify the selection preserves its captured note-space grab offset under the latest view matrix.
13. Leave the edge band, reach both scroll boundaries, and extend the annotation-aware bottom range with the active preview. Verify frame scheduling stops when no progress is possible, resumes only after a current pointer, extent, or range change permits progress, never queues more than one frame, and performs no synchronous read-after-write layout cycle, full-scene scan, offscreen mount, worker job, timer, or React note-root commit.
14. Commit once through pointer up and verify exactly one move or transform-and-rebind operation, one host-history effect, exact Undo and Redo, and one coalescible save generation. Repeat Escape, pointer cancellation, lost pointer capture, stale tokens, mode or view replacement, disposal, and unload and verify exact rollback plus zero retained frame, capture, pointer sample, listener, preview, history, recovery, or persistence work.

### 2.13 Annotation-Aware Bottom Scroll Extent

1. Record the native reachable bottom and effective trailing allowance of an empty note and of a Markdown-only note in each supported mode. Attach Inkbook with no annotation and verify both values remain unchanged. The observed current Obsidian editing baseline is approximately one half editor viewport, but the assertion compares Inkbook with the native value from the same concrete view rather than treating `0.5` as an exact cross-version constant.
2. In an otherwise empty note, begin a Pen and a Highlighter gesture in the native trailing area and continue below the previous end. Verify the active preview extends the reachable surface at most once per frame and the committed lowest paint bound remains fully reachable with the same effective host allowance below it.
3. Place each element kind below the final Markdown line, including maximum-width strokes, filled and outlined shapes, curved Lines and Arrows with caps, Tables, axes with guides, attached endpoints, and Groups. Verify the complete paint bottom contributes without selection chrome, hit tolerance, background, toolbar, or status UI changing the result.
4. Move or resize the lowest fixed element, reflow the lowest text-bound projection at two pane widths, and exercise commit, cancellation, deletion, Undo, and Redo. Verify deterministic growth or shrink, native scroll clamping only when the valid range contracts, and no extent-only Markdown, scene, history, recovery, or sidecar mutation.
5. Open the same note in panes with different viewport heights, widths, modes, and 50, 100, 175, and 400 percent zoom. Verify one shared canonical scene but independent current extents, `T = 0`, nonzero `T`, inverse conversion into note coordinates, outward-rounded conversion back into host coordinates, and no feedback growth from the previous Inkbook contribution.
6. Repeat the reachability, reflow, section replacement, and disposal cases in Reading View. Verify one whole-note extent carrier, no section-owned duplicate, and zero residual carrier or aggregate after mode change, view detach, pop-out migration, and plugin unload.
7. Run the 5,000-element minimum and 10,000-element stress fixtures with the lowest element inserted, changed, reflowed, and removed. Assert affected-entry aggregate work, no complete-scene or DOM scan, no offscreen mount, at most one changed-value carrier write per frame, zero React note-root commits, and compliance with the existing frame, heap, cache, and teardown budgets.

## 3. Persistence and Fault Tests

Required cases include:

- YAML marker write succeeds and sidecar write fails;
- sidecar write succeeds and marker write fails;
- marker exists while sidecar is missing;
- marker locator is absent, absolute, traversing, hidden, malformed, points to a folder, has the wrong suffix, or resolves to a valid sidecar for another note;
- sidecar exists while marker is missing or false;
- note rename races with a sidecar save;
- note rename crashes or fails after every individual relocation-saga step and resumes without losing recovery entries;
- rename destination already exists;
- external sidecar edit occurs with local unsaved operations;
- an external sync engine overwrites the sidecar before the plugin observes the change;
- stale save acknowledgement arrives after a newer generation;
- Obsidian closes or plugin unloads during a gesture and during a save;
- recovery journal exists with matching, stale, corrupt, and over-limit bases;
- newer major schema opens read-only and is never overwritten;
- current and immediately over-limit sidecars, strokes, tables, contexts, and nesting;
- canonical Table, 2D axes, and 3D axes records round-trip exactly, while invalid dimensions, unordered, crossing, too-close, or over-limit divider offsets, invalid vector values, and invalid grid divisions fail before scene construction;
- canonical scene records round-trip with `elements` exactly in `objectOrder` and Groups in Unicode code-point `groupId` order through the runtime canonical iterators; alternate array order is rejected. Group cycles, duplicate children, multiple direct parents, unresolved references, fewer than two children, nesting beyond 32, noncontiguous leaves, or a flattened `childIds` order unequal to the occupied `objectOrder` subsequence fail before scene construction and clipboard admission;
- all closed V1 IDs, discriminators, colors, caps, dashes, styles, geometries, bindings, attachments, component revisions, object-order permutations, and note-appearance records round-trip canonically; unknown values, invalid ID alphabets, duplicate IDs, revision overflow, and cross-kind geometry or style records fail before scene construction;
- `delta-varint-v1` golden fixtures cover positive, negative, and zero deltas, pressure-present and pressure-absent records, one-point strokes, five-byte boundaries, canonical base64url, minimal varints, count and trailing-byte failures, overflow, and deterministic decode-encode equality;
- operation property tests cover every closed patch and atomic batch, exact restoration of all non-revision canonical values, monotonic scene and changed-component generations, a fresh dispatch ID for each Forward, Undo, and Redo, stable retry identity, repeated Undo and Redo, branch-after-Undo without revision ABA, Create or Delete placement semantics, Group leaf-block order equality, dependency-closed delete, Line and Arrow endpoint-operation exclusivity, and all-or-nothing rejection;
- attached-endpoint fixtures cover every valid area and axis port, invalid target kinds and port IDs, pointer distances below, at, and above 12 CSS pixels, distance, z-order, and port-order ties, pointer attach or free placement, keyboard port pick, Detach, cancellation, target move, resize, rotation, Line-or-Arrow-own-binding-first then attached-port replacement order, both-free rigid geometry, independently moving attached targets in two pane widths, current-token target deletion, exact Undo, reverse-index-only invalidation, and the 1,024/1,025 attached-endpoint boundary. Detach and target deletion after moving the Line's or Arrow's own binding inverse-project the visible port exactly once, produce no doubled offset, and reject stale, ambiguous, or non-invertible projections without mutation;
- clipboard fixtures cover custom MIME and plain-JSON fallback, fresh IDs, current-destination binding inference, keyboard and pointer placement, exact duplicate offset, internal and external Line or Arrow attachment targets, nested Groups, cut acknowledgement ordering, atomic failure, malicious JSON, unknown versions, and values immediately at and over every payload limit;
- repeated load, detach, and unload leaves no observers, listeners, timers, SVG roots, sessions, or pointer captures.
- recovery append fails from quota, transaction abort, disposal, and backend loss before publication, leaving scene and history unchanged;
- the production IndexedDB recovery adapter passes schema creation, upgrade, atomic compare-and-swap, abort, quota, corruption, restart, concurrent-session, exact byte-accounting, deletion, and idempotent disposal tests in every supported desktop and Android compatibility cell; unavailable or non-transactional storage keeps annotation mutation read-only;
- a crash after `prepared` persistence but before durable `host-recorded-forward` acknowledgement never auto-replays and leaves the scene unchanged;
- a crash after durable `host-recorded-forward`, `host-recorded-undo`, or `host-recorded-redo` acknowledgement but before scene publication restores only that recorded direction exactly once;
- host-recorded replay succeeds only when the current durable source generation and exact Markdown digest match the attempt; a changed digest with otherwise matching sidecar and scene state publishes nothing and enters bounded reattachment or review;
- failure to persist a `host-recorded-*` transition leaves the scene unchanged, makes the already admitted host effect visibly inert, and never guesses or auto-replays a direction;
- a completed forward save removes its recovery attempt while preserving the actionable host effect; a later Undo and Redo each create a new monotonic bounded direction attempt, survive a crash exactly once, and remove only their own attempt after save acknowledgement;
- repeated save, Undo, save, Redo, and save cycles remain within the 8 MiB per-note recovery budget and 32 MiB per-pane history-payload budget without retaining completed attempts;
- a source transition from G0 to G1, a host-recorded annotation attempt admitted at G1, and a later transition from G1 to G2 recover in total `SessionOrder`: the attempt applies at its unique G1 node, every introduced or replaced binding maps through the remaining G1-to-G2 suffix, and replay at G0 or G2 is rejected;
- acknowledging save S1 atomically removes exactly its covered attempts and checkpoints and rebases every retained direct-successor attempt and checkpoint from the expected prior base to the acknowledged replacement base; a gap, fork, stale base, missing covered identity, or conflicting successor aborts cleanup and publishes no acknowledgement;
- recovery before the first `Vault.create()` uses only the `absent-first-sidecar` load variant, validates null sidecar base, expected path, current Markdown evidence, pending identity, and matching host-recorded Forward, then creates revision 1 exactly once; a prepared-only, mismatched, collided, or already-existing case creates nothing;
- a durable source checkpoint maps affected canonical anchors without traversing every actionable history entry; later Undo and Redo lazily materialize only their stable history entry through the bounded composed-map graph and restore exact mapped values, while an unsafe, excessive, or partial materialization blocks further annotation mutation;
- plugin unload or editor disposal while the host could still emit an Inkbook effect either proves that effect unreachable or restores its complete actionable history entry, lifecycle, owner lease, epoch, and accepted host-sequence high-water mark before accepting it; otherwise the cell fails closed and a late effect cannot mutate the scene;
- the chosen sync configuration transfers both `.md` and `.inkbook.json`, while an excluded or missing sidecar produces visible drift and never an empty replacement;
- conflict-copy names collide, the three-copy cap is reached, and no existing conflict copy is overwritten or automatically removed;
- deleting a Line or Arrow attachment target detaches at its last resolved endpoint and undo restores target plus attachment exactly;
- moving a multi-selection with different bindings atomically rebinds every non-fixed element, preserves every `fixed` binding, or rejects the complete move without partial mutation;
- `text-range`, `text-position`, and `fixed` binding records round-trip through the sidecar codec without changing canonical fields;
- binding parsing rejects unknown discriminators, invalid presentation-confidence combinations, non-finite offsets or margins, and source ranges immediately over the configured limit;
- serialized scenes contain no originating toolbar control, host-layout revision, rendered fragment, enclosing-region bound, viewport coordinate, or per-view projection state;
- internal Markdown transaction bursts produce one contiguous prior-to-replacement digest chain with at most one active and one replaceable latest recovery checkpoint, persist the replacement Markdown digest without an annotation effect event or a per-element editor-path scan, force a durable checkpoint barrier before an annotation command against transient source, reject stale completions, coalesce save generations, and create no checkpoint for view-only reflow;
- reopen with a validated sidecar source root and checkpoint chain applies only the strictly contiguous prefix whose replacement generation, digest, and UTF-16 length match current Markdown; a gap, fork, conflicting duplicate, ambiguous digest, unrelated digest, or invalid map publishes no mapping and enters bounded reattachment or explicit review;
- deliver the same host Markdown transition from two panes in both orders and verify compare-and-swap admission creates exactly one source generation, offset mapping, recovery checkpoint, and save generation; a matching duplicate advances only its view token, while a nonmatching digest or offset-map digest enters bounded external-change handling;
- sidecar encoding materializes affected offsets, associations, bounded contexts, block kinds, and block fingerprints from the exact immutable replacement Markdown snapshot, while digest or generation mismatch aborts and restarts from the current durable generation;
- successful close within the two-second headless flush bound survives reopen exactly, while timeout and plugin unload with an unprotected source generation retain only acknowledged recovery and enter bounded external reattachment without claiming exact mapping durability;
- source-checkpoint quota, transaction, disposal, and backend failures retain the last durable anchors, show `Source checkpoint pending` while a view exists, block annotation mutation and sidecar saving, allow native Markdown editing, and recover through Retry or bounded external reattachment without claiming an exact lost mapping;
- the YAML marker uses only the synchronous `processFrontMatter()` metadata exception for `inkbook-annotations` and `inkbook-sidecar`, creates no native-editor undo item, releases the `NoteSession` queue turn while awaiting its host event, admits that source transaction independently, and cannot publish the first annotation before its observed source checkpoint and layout generation are current;
- an external rename or deletion of an open session's resolved sidecar immediately enters `marker present, sidecar missing` drift, blocks annotation mutation and automatic recreation, and preserves acknowledged recovery, while a relocation-owned sidecar event is filtered exactly once;
- `Remove annotations from current note` registers one removal identity before trash, treats trash acknowledgement and the matching delete event as an order-independent two-signal barrier, and removes both YAML keys plus clears session and recovery only after both signals and marker removal succeed; tests cover event-before-ack, ack-before-event, rejection, two-second timeout, mismatch, replacement, disposal, late and duplicate events, marker failure, stale-identity invalidation, and external-drift classification;
- an owned Markdown file rename enters exactly one file relocation saga, while unrelated file and sidecar events do not;
- parent-folder and configured-root renames rekey every affected loaded session, resolved-sidecar identity, YAML locator, device-local zoom key, and recovery key through bounded indexed work, update every loaded sidecar's embedded Markdown path and storage layout through compare-and-swap, and lazily validate plus repair an unopened located sidecar on next open through target-aware local prefix rules, all without a Vault-wide scan; tests cover adjacent and `vault-root` layouts, `A` to `B` to `C`, the valid inverse `A` to `B` to `A`, reuse of a new unrelated `A` after an older `A` to `B`, overlapping parent and child renames, complete-segment matching, local generation order, longest-prefix tie-breaking, restart between moves, zero and multiple target paths, corrupt non-increasing or ambiguous rules, duplicate child-event filtering, durable-cursor resume, unrelated-folder no-ops, two installations with different storage defaults plus synchronization in both directions, and adversarial branching fixtures immediately at and above the 128-rule, 32-hop, 4,096-state, 8,192-transition, 1-MiB, 100-ms desktop or Android-tablet, and 250-ms Android-phone limits with deterministic read-only exhaustion;
- storage-policy changes affect only new sidecars until explicit migration; migration preview, confirmation, bounded discovery, continuation, cancellation between files, destination-folder creation, create collision, external edit, setting revision change, interruption after every durable step, resume, locator update, source checkpoint, and final state are tested without startup scans, overwrite, empty replacement, scene mutation, or history event;

Every failure case verifies that Markdown remains editable, acknowledged data is not lost, unsafe writes do not occur, and the status shown to the user is truthful.

## 4. Geometry and Rendering Tests

Property tests MUST cover:

- note, viewport, and screen matrix round trips across zoom;
- finite coordinate validation and inverse-transform failure;
- stable path generation and compact codec round trips;
- pressure and constant-width strokes;
- shape, Table, axes, linear-endpoint, Group, and multi-selection transforms with constant stored widths;
- exact derivation of linear, oriented area with Table-divider handles, axis-set, and aggregate selection models;
- endpoint, cap, curve, port, and attached Line or Arrow geometry;
- Line and Arrow quadratic curve handles, curve bounds, hit testing, cancellation, exact undo, and underline-binding revalidation;
- Table, 2D axes, and 3D axes semantic geometry, composed paths, whole-object selection, limits, transforms, persistence, and inverse patch values;
- spatial-index insert, update, remove, and query equivalence against brute force;
- annotation paint-bottom aggregate equivalence against brute force after insert, update, removal, reflow, preview, cancellation, and disposal, without using brute force in the production path;
- lasso geometry rules;
- affected-bounds cache invalidation;
- deterministic z-order and group operations;
- deterministic binding classification and tie-breaking;
- `BlockKindV1` classification and `BlockFingerprintV1` golden fixtures across CRLF, LF, NFC, NFD, trailing spaces, blank lines, and every supported block kind;
- exact 128-unit context extraction at document edges, valid surrogate pairs, rejected split pairs, combining marks, ZWJ emoji, and canonical comparison;
- source-range boundary mapping through Unicode edits, including `before = -1`, `after = +1`, insertion at both range edges, deletion, collapse, reversal, out-of-bounds mapping, and deterministic `SourceOffsetMapV1` composition;
- signed enclosure-margin capture and projection at `0`, `-1024`, `1024`, multiple paragraphs, changed line height, and invalid non-positive or non-finite line height;
- the exact `text-position` and `fixed` projection equations for every element kind, including binding conversion, movement, an axis-length edit, and any rotation or resize that changes canonical bounds center, with atomic offset or anchor recomputation and no preview-to-commit jump;
- text-fragment and multi-paragraph enclosure projection across width changes;
- invariance of canonical geometry under binding reflow;
- manual binding correction with exact inverse patch values and monotonic dispatch revisions;
- incremental binding evidence for a 100,000-point gesture with no full-sample pointer-up scan.

Deterministic semantic SVG, DOM, and accessible-tree regression tests MUST use small fixtures in Obsidian default light, default dark, and host forced-colors or high-contrast mode where exposed. Stable visual surfaces additionally use screenshot regression with explicit tolerances. Pixel tests cannot replace semantic assertions.

## 5. Accessibility Tests

Automated checks MUST verify every machine-observable item below:

- accessible names, roles, pressed and expanded states;
- toolbar and menu keyboard navigation;
- Escape dismissal and focus restoration;
- context menu through Shift+F10 and long press;
- native Obsidian context menu on Markdown, Inkbook target menu on annotations, and no menu after claimed secondary-button pan;
- visible focus at 200 percent application zoom;
- 44 by 44 CSS-pixel compact targets;
- software keyboard text entry in Cursor mode;
- pointer-free selection of next and previous annotation from no prior annotation focus, deterministic boundary behavior, accessible position and type announcement, bounded reveal, and selection-summary focus;
- Group-root navigation at the earliest descendant's position, descendant replacement, accessible Enter group, ordered child traversal including nested Groups, and Escape to the parent root;
- status announcements without focus theft;
- `Text binding` radio-group names, checked state, disabled explanation, `Mixed` state, and focus behavior;
- contrast of at least 4.5:1 for normal text, 3:1 for large text, and 3:1 for essential non-text controls, focus, selection, and graphical indicators in every supported light, dark, and high-contrast theme;
- reduced motion;
- contrast and non-color state indicators.

Human accessibility review is limited to qualities unavailable through a programmatic interface, such as actual screen-reader comprehension, tactile input quality, and perceptual usability. It occurs once in the owning phase or release sanity boundary, not as a duplicate execution of the list above.

## 6. Performance Acceptance

The benchmark fixture and budgets in [Quality and Performance](09-quality-and-performance.md) and [SVG Rendering](06-svg-rendering.md) MUST pass through the smallest applicable automated layer. Structural work, algorithmic scaling, simulated scheduling, and local resource limits run in routine CI. Absolute physical-device claims require an automated calibrated target and MUST NOT be inferred from simulation. This section does not require one monolithic harness, dedicated evidence model, or separate runner tree.

The existing unit, integration, benchmark, build, or host suite that owns a product path measures its applicable input-to-preview, next-presented-frame, paint, dropped-frame, selection, selection move, edge autoscroll, resize, endpoint-snap, Table-divider, axis-length, hit-test, Select All, lasso, aggregate transform, Undo or Redo, native one-finger pan, scroll, zoom, culling, background, binding, projection, reflow, first-overlay, encoding, save, source-checkpoint, mapping, digest, recovery, parse, mutation-readiness, and teardown metrics. Tests add only metrics for product paths that already exist. Annotation recovery preparation plus durable `host-recorded-*` transition is checked end to end, with component timing retained only when useful for diagnosis. Every measured metric references the explicit stable `PERF-5K-*` or `PERF-10K-*` row ID from [Quality and Performance](09-quality-and-performance.md). Selection movement uses `PERF-5K-MOVE-PRESENT` or `PERF-10K-MOVE-PRESENT`; its autoscroll frames and native one-finger pan additionally use the corresponding `VIEW-FRAME` and `VIEW-PRESENT` rows. `Input-to-preview` and `first overlay` end only after visible presentation, not after JavaScript or DOM mutation alone. Long-task and retained DOM or heap checks live in the owning lifecycle suite when the test environment exposes those signals.

Cold means no decoded scene, index, or geometry cache exists for the note. Warm means the note session and unchanged encoded chunks remain available. The capacity suite runs deterministic 5,000- and 10,000-element fixtures, each with exactly one valid binding per element, dispersed and dense visible-cluster variants, recorded digests, and verified encoded sizes within all sidecar limits. Save benchmarks report encoding, Vault operation, and acknowledgement phases separately. Last-view detach reports synchronous disposal separately from any recovery-protected asynchronous flush.

The capacity suite MUST verify that the 5,000-element tier passes every applicable desktop, tablet, and phone budget and that the 10,000-element stress tier passes every predeclared p95, p99, maximum, steady-heap, peak-heap, frame, slicing, correctness, and full-interactivity threshold. It includes selection and resize of one visible shape or Table, one free-to-attached and attached-to-free Line or Arrow endpoint edit, one Table-divider edit, one coordinate-system axis-length edit, plus aggregate operations over 100, 1,000, 5,000, and 10,000 selected members. No passing run may scan or rebuild the complete scene for a single-element operation. The executable benchmark suite fixes its fixtures and thresholds before measurement; missing or retrospectively changed thresholds fail the run.

Every `PERF-5K-*` and `PERF-10K-*` test names its exact stable row ID and directly asserts every required percentile or structural limit. Missing counterparts, implicit name matches, absent assertions, and thresholds changed after observing a failure are rejected in review. No external performance profile or result validator is required. A 10,000-element one-element geometry, style, order, or Group change asserts persistent runtime-store path-copy work, visited records, allocated bytes, retained old branches, and spatial-index mutations proportional only to affected records. It fails on flat `elements`, `objectOrder`, or Group-array materialization outside a declared codec operation.

Resource tests exercise one unit below, at, and above every implemented queue, cache, worker, session, persistence, recovery, view, and retained-buffer limit. They assert safe rejection before mutation, fair progress, no dirty or actionable eviction, truthful limited state, exactly-once ownership transfer, and idempotent release after success, failure, cancellation, close, and unload. Combined deterministic fixtures cover the cross-subsystem pressure that the current implementation can actually create. A global resource ledger is not required unless local limits cannot enforce the aggregate heap budgets.

The source-capacity suite exercises every `SOURCE_COORDINATION_LIMITS_V1` boundary below, at, and above with ASCII, multibyte UTF-8, astral characters, one huge block, many blocks, fragmented edits, map composition, deep actionable history, and streaming digest. Golden digests prove byte equality across chunk boundaries below, at, and above 256 KiB for the selected incremental implementation and any host-proven alternative, while allocation evidence proves that no second complete Markdown or UTF-8 string is created. Over-limit source generations allocate no complete map, canonical JSON copy, UTF-8 copy, or domain scene; native Markdown remains editable while annotation mutation is read-only. A deep-history checkpoint visits no unrelated entry, and later Undo or Redo materializes one exact entry through no more than the permitted mapping nodes.

The persistence-capacity suite admits several notes whose worker queue drains into deliberately blocked Vault operations. It records snapshot roots, encoded output, comparison bases, transfer buffers, acknowledgements, active permits, and byte high-water marks through success, conflict, cancellation, crash, disposal, and retry. It exercises exact comparison and save below, at, and above the 16 MiB desktop or tablet and 8 MiB phone writable ceilings, while a 16 MiB phone sidecar remains a read-only parse and recovery case. It loads the largest simultaneous valid decoded-memory fixture immediately below, at, and above the parser and decoded-memory limits and rejects before immutable construction when the operation cannot fit. Recovery-store tests cover 4,095/4,096/4,097 note records, 511/512/513 direct successors, indexed note isolation, no whole-store scan, and exact atomic acknowledgement. The 512-successor cleanup records visited records, transaction bytes, writes, main-thread slices, and worker work and enforces `PERF-10K-RECOVERY-CLEANUP`.

When React product UI exists, focused integration tests instrument its normal production-shaped composition and verify zero note-root commits and zero per-element renders during pointer sampling, gesture preview, endpoint snap-candidate changes, Table-divider movement, axis-length movement, scroll, pure zoom, culling, retained-node updates, selection-chrome updates, and worker progress. Tool, style, and selection-summary changes may commit only the subscribed toolbar, stylebar, menu, or status subtree. A 10,000-element scene MUST NOT create 10,000 React component instances. A separate profiling build is added only if the normal test boundary cannot expose these counts.

Re-entrancy tests MUST make scene, selection, status, and worker-completion listeners synchronously request additional work. The note session queues or coalesces those requests, preserves total command order, publishes each accepted command exactly once, and never produces recursive publication, render loops, duplicate history, or duplicate save generations.

Worker contract and performance tests MUST cover every `WORKER_ADMISSION_V1` boundary immediately below, at, and above its threshold, plus normal completion, priority, cancellation, stale revision, queue and byte-budget exhaustion, worker crash, plugin unload, transferable-buffer ownership, canonical-buffer non-detachment, and the sliced fallback when workers are unavailable. On a conforming worker platform, every admitted pure phase runs off the main thread except for bounded request packing and final publication. The fallback executes at most 2 ms per active-interaction slice and 4 ms per idle slice without partial canonical state or fixed waits.

Worker tests also refill the queue while every permitted worker retains maximum input, scratch, worst-case output, and in-flight transfers. Cancellation must acknowledge within the specified deadline; crash during transfer followed by reschedule must inherit one reservation and never overlap two owners. A maximum-point stroke uses its segment hierarchy for adversarial hit tests without scanning all samples. Spatial and overscan tests exercise exact 4,095/4,096/4,097 candidates, multiple immutable query windows, 2 MiB resident metadata, extreme zoom, overlapping geometry, stale continuation cancellation, and deterministic truthful completion. Dense supported 5,000- and 10,000-element fixtures must reach full mutation readiness without retaining the complete candidate set; an independent hard-limit violation remains truthful and read-only. Range tests exercise 511/512/513 visible fragments and 256 KiB derived records without offscreen materialization.

The attachment suite moves and rotates one target with 1,024 fully visible dependents and with 1,024 mostly offscreen dependents, measuring presented-frame, allocation, DOM, reverse-index, worker, and commit work under `PERF-10K-ATTACH-FANOUT`. The clipboard suite pastes 1,000 and 5,000 mixed elements, uses one shared layout index for bulk inference, cancels between bounded chunks without partial state, and enforces `PERF-10K-PASTE-5K`. Group and history suites enforce `PERF-10K-GROUP-PATCH` and `PERF-10K-HISTORY-MATERIALIZE` with maximum valid stores.

Lifecycle leak tests independently repeat attach or detach, file change, mode change, Reading View section reprocessing, desktop pop-out migration, worker or save cancellation, and complete plugin unload for at least 50 cycles. They enforce available post-GC slope and plateau checks plus zero remaining subsystem-local owners, queues, listeners, observers, timers, workers, ports, and captures rather than relying only on one final heap delta. A file or mode change proves complete old-adapter disposal before a new adapter binds and rejects every delayed old-generation callback.

Package performance acceptance automatically checks exact raw and gzip artifact bytes and the embedded-worker size during the build or release lane. Cold parse, evaluation, startup, presentation, and peak-heap budgets run only where an automated host exposes the required signals. Results come directly from the executable test or release run and are never replaced by user-entered measurements. Simulation proves deterministic regression and complexity properties, not absolute physical-device latency, paint, heap, touch, or thermal behavior.

## 7. Coverage and Test Completeness

Automated tests MUST cover at least 85 percent of production lines and every relevant normal, boundary, failure, race, cancellation, recovery, disposal, and abuse behavior that can be driven or observed through code. Tests use clear behavior-oriented names and stay close to the production area they verify. A feature is incomplete when any automatable normative behavior lacks an executable test. Manual evidence is permitted only for a quality that no programmatic interface can observe, and it is limited to the single concise phase-sanity scenario. Empty manifests, generated requirement inventories, and written procedures are not test evidence.

## 8. Obsidian Host Contract Acceptance

The following tests are release-blocking when their product surface exists. A continuously run fake-host contract matrix covers available, absent, malformed, throwing, delayed, stale, and disposed capabilities. Packaged-plugin automation is added for contracts a fake cannot establish and only where a controllable host exists. A packaged-host limitation MUST NOT be shifted into a repeated user checklist or used to justify a speculative runner framework.

### 8.1 Package and Compatibility

- validate canonical plugin ID `inkbook`, folder-ID equality, Community ID and display-name uniqueness, permitted display-name characters, real author presence, description length, punctuation and content, SemVer version, `minAppVersion`, `isDesktopOnly: false`, and conditional author or funding URLs;
- reject a manifest-tag mismatch, missing `main.js`, `manifest.json`, or `styles.css`, development bundle, sample scaffold, and transitive Node.js, Electron, native-module, or remote-code dependency;
- when `minAppVersion` changes, verify root `versions.json` selects the newest compatible plugin release and rejects malformed or impossible mappings;
- load the production package in a dedicated test Vault on minimum desktop and Android, reload the plugin after build changes, and verify startup, disable, enable, and unload;
- prove that every imported Obsidian API exists at the declared baseline or follows its tested guarded fallback.
- record the exact Obsidian version, platform, OS build, device model or desktop hardware profile, imported API set, expected capability, and guarded fallback outcome for every supported release environment;

### 8.2 Startup and Lifecycle

- instrument `onload()` and verify it performs no Vault enumeration, sidecar parse, scene construction, worker creation, whole-view measurement, or recovery scan;
- fire Vault `create` before and after layout readiness and verify pre-ready work returns while post-ready owned work remains bounded;
- unload before and during the non-disposable `onLayoutReady()` callback and verify the invalidated lifecycle token blocks every side effect, registration, and asynchronous continuation;
- create and dispose every view, section, menu, modal, observer, timeout, animation frame, interval, worker, port, framework root, pointer capture, and session owner, verifying child-before-parent and idempotent teardown;
- disable the plugin during startup, open, gesture, worker work, save, Reading View reprocessing, and pop-out migration and verify no callback publishes after disposal;
- statically and dynamically verify that production code does not depend on global `app`, `window.app`, or the global document or window for view-owned work.
- extract and inspect the build-time worker payload from `main.js`, launch it through the packaged adapter on desktop and Android, verify the chosen local URL or Blob mechanism is permitted, and prove that no fourth release artifact or remote execution path is required.

### 8.3 Workspace and Views

- open Live Preview, Source, and Reading View, then verify one correct view adapter per concrete leaf and host view and one shared canonical note session for panes of the same file;
- open a Bases file and non-Markdown leaves and verify no Inkbook toolbar, overlay, sidecar discovery, YAML marker, Ribbon action, status-bar item, custom `ItemView`, or replacement leaf is created;
- replace, detach, relink, change mode, and change file in a leaf and verify the corresponding old view-local owner is completely disposed before one fresh owner binds, with no old-generation callback or resource surviving;
- discover a leaf with `WorkspaceLeaf.isDeferred` passively and verify zero `loadIfDeferred()` or `revealLeaf()` calls and no import or `instanceof` use of a non-public `DeferredView`; then invoke an explicit command, await `revealLeaf()`, revalidate type and file identity, and act only on the current concrete view;
- move a Markdown leaf between the main and desktop pop-out windows and verify `onWindowMigrated()`, `element.doc`, `element.win`, `element.instanceOf()`, and `event.instanceOf()` bind DOM construction, type checks, events, timers, animation frames, framework roots, and focus to the element-owned window with no old-window leak.

### 8.4 Editor Integration

- verify Obsidian creates and owns every Markdown `EditorView`; Inkbook creates none, calls `registerEditorExtension()` once, each host editor creates exactly one Inkbook `ViewPlugin` value, and `destroy()` releases every per-editor resource;
- execute every editor command through its supplied `Editor` and `MarkdownView`, including two panes where the global active view differs, and verify `checking: true` is side-effect-free while both checks revalidate capability;
- verify public commands have stable IDs without an `inkbook-` prefix, ship without default hotkeys, and remain independent of toolbar order;
- exercise the single typed CodeMirror bridge with the host property present, absent, malformed, and changed, verifying one narrow suppression and safe unavailable results;
- send ordered and stale typed state effects and verify pure state-field updates, ordered reduction, view and revision rejection, no direct field mutation, and no recursive dispatch;
- verify the existing host history receives isolated invertible annotation effects through the production bridge, no second `history()` extension or replacement keymap is installed, effect payloads stay bounded and actionable, branching releases unreachable payloads, and view disposal releases all bridge state;
- update text, selection, viewport, scroll, layout, and unrelated editor state and verify post-update viewport reads, at most one current projection request per frame, bounded overscan, and zero forced offscreen mounting;
- inspect decorations and verify they do not replace or hide Markdown, add line breaks, change vertical layout, or retain canonical annotation scene data;
- verify one editor-owned annotation scroll-extent contribution preserves the concrete host's effective trailing allowance, changes no native line position, uses no private CodeMirror measurement or direct mutation of CodeMirror-managed descendants, excludes its prior value from the next derivation, and is removed on editor disposal;
- perform a plugin-originated Markdown change and verify one native editor transaction and one host-history event, while an associated annotation operation contributes its own immediately ordered invertible effect without changing Markdown.

### 8.5 Reading View

- process several sections, detach and reprocess them in different orders, and verify one whole-note overlay, one child owner per reported section, no duplicate observer or region, and exact section-generation replacement;
- exercise every toolbar, stylebar, handle, context-menu, clipboard, hotkey, and command entry point in Reading View and during a concurrent mode change, verifying final mode revalidation, accessible disabled state, and zero Markdown, scene, history, recovery, or sidecar mutation;
- verify source mapping uses documented processor context and bounded evidence, never rendered DOM order alone;
- remove or corrupt source evidence and verify degraded read-only placement with no guessed canonical binding;
- verify the whole-note coordinator, rather than any section child, owns one annotation scroll-extent contribution that follows current projected paint bounds, is updated without removal during section reprocessing, and is removed on mode change, view detach, or disposal;
- verify Inkbook registers no Markdown code-block processor and does not replace authored rendered content.

### 8.6 Host-Native UI and Direction

- invoke annotation context menus through pointer, Shift+F10, and long press and verify Obsidian `Menu`, correct owner-window coordinates, native Markdown menu preservation, and focus restoration;
- cancel and confirm recovery, conflict, and destructive Obsidian modals, verifying no pre-action mutation, Escape preservation, close-before-command, and at-most-once action;
- scan production DOM sinks and exercise malicious labels, settings, sidecars, and Markdown, verifying safe creation and text APIs and no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or untrusted SVG path;
- validate every Obsidian or custom icon on minimum and release versions, unique custom IDs, static markup, custom geometry within the `0 0 100 100` view box, Lucide geometry conventions, theme sizing, and absence of user data, URLs, styles, scripts, and event attributes;
- test left-to-right, right-to-left, and mixed-direction editor lines and Reading View blocks, logical layout properties, `dir="auto"`, host-provided automatic icon mirroring, physical-icon opt-out, keyboard navigation, and pop-out windows without mutating host direction;
- verify save, conflict, recovery, and inference output uses one view-scoped visible surface and accessible live region, not a persistent Obsidian status-bar item.

### 8.7 Settings and Vault

- on Obsidian 1.8.7, verify the imperative `PluginSettingTab.display()` path and prove no call depends on `getSettingDefinitions()`;
- invoke the toolbar Settings control with the guarded public host capability available and unavailable, verifying either the registered tab opens or accessible navigation instructions appear, with no untyped settings-internal access;
- test null, malformed, old, future, and externally changed plugin-global and device-local settings, complete validation before consumption, last-valid retention, session-only failed writes, Retry, and mounted-view update;
- exercise a verified external-settings notification when the host cell exposes one, then exercise a cell without that capability and verify reload only on plugin load or settings-tab reopen, no polling, and no live-synchronization claim;
- if dual declarative settings are introduced, run the same semantic suite against both paths and fail on any control, default, validation, migration, or persistence difference;
- verify toolbar membership cannot be added, removed, duplicated, or moved across groups and that keyboard or touch Move up, Move down, and Reset remain available without drag;
- verify `adjacent` is the storage default; validate a custom Vault-relative root; reject absolute, traversing, hidden, `.obsidian`, malformed, and outside-Vault values; preserve the last valid snapshot on failure; and show exact path previews for same-name notes in different folders;
- change the default on one device and open a synchronized existing note on another device with a different default, verifying the validated YAML locator selects the same sidecar without a scan or duplicate creation;
- rename the configured root, inject `saveData()` failure, restart, and verify the replacement policy requires Retry, first-sidecar creation remains blocked under both paths, the old root is never recreated implicitly, and creation resumes only from an acknowledged policy plus completed relocation state;
- verify constructed Vault paths are normalized, event values are narrowed from `TAbstractFile` to the required `TFile` or `TFolder` branch, file-only operations reject folders, and known-file lookup does not scan the Vault;
- verify the `processFrontMatter()` callback synchronously changes only `inkbook-annotations` and `inkbook-sidecar`, performs no await or nested host call, preserves unrelated properties, and turns promise rejection into visible marker drift;
- verify explicit orphan review uses `getFiles()`, exact suffix filtering, bounded continuation, no hidden-folder support, no `getMarkdownFiles()`, and no startup scan;
- race `cachedRead()` base capture, asynchronous encode, synchronous `Vault.process()` compare, external modify, rename, and unload, verifying the process callback remains synchronous and side-effect bounded;
- verify annotation removal uses the host trash preference and never falls back to permanent `Vault.delete()`.

### 8.8 Android and Release

- verify the private-development repository settings, least-privilege workflow permissions, Dependabot schedules and grouping, required check names, protected `main` and `v*` tags, SHA-pinned direct actions, gitleaks checksum verification, and draft-release behavior against [GitHub and CI](17-github-and-ci.md);
- seed dependency minor, patch, and major update fixtures and verify grouped minor or patch auto-merge waits for `CI`, `gitleaks`, and `Validate PR Title`, majors remain separate and manual, every squash title is Conventional Commit compatible, and no docs-only pull request remains indefinitely pending;
- run every scriptable touch, stylus, software-keyboard, background, overlay, worker, sliced-fallback, storage, reload, and memory case through automated Android device or emulator orchestration; physical-device automation remains required for claims that emulation cannot establish, while the one phase sanity check may assess interaction feel without collecting measurements;
- execute the production bundle with absent desktop globals and reject unsupported syntax, including RegExp lookbehind without the declared and tested platform support plus fallback;
- verify README disclosures, local-only runtime data flow, sidecar synchronization warning, independent third-party status, license, and Community policy compliance against current official rules;
- review pending Dependabot and runtime updates before release, keep every direct dependency on the newest stable mutually compatible release, and verify each supply-chain-sensitive action uses its reviewed immutable digest;
- build a draft release with `npm ci` from the resulting reviewed lockfile, record every exact resolved version, require exact tag and manifest version equality, attach the three loadable artifacts, verify any compatible-version fallback, and manually approve publication;
- verify the first present package script in Community scanner order `build`, `build:plugin`, `compile` runs the production plugin build;
- verify no runtime self-install, self-update, executable download, obfuscated behavior, undisclosed network access, telemetry, or first-party Obsidian claim exists.

## 9. Phase Sanity Scenarios

Each phase has exactly one human sanity scenario after every automated exit gate passes. It uses the exact production artifact produced and inspected by the build on one representative user-available supported environment. The user reports only pass or fail and an optional short observation. The scenario contains at most three short actions, has no manual timings, heap readings, digests, version inventories, logs, database inspection, screenshots, repeated host cells, or exhaustive feature matrix, and MUST NOT substitute for automated tests.

| Phase | Concise sanity scenario                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Enable the package, open one Markdown note, and confirm native editing plus the visible Inkbook host probe remain usable.          |
| 1     | Open and edit one note, then confirm normal native behavior and that temporary probe UI is absent.                                 |
| 2     | Open the supplied note in two panes, make one Markdown edit, and reopen it to confirm no visible data loss or unexpected conflict. |
| 3     | Draw one stroke, Undo or Redo it once, and reopen the note.                                                                        |
| 4     | Edit text associated with one annotation and confirm its visible projection follows the changed text.                              |
| 5     | Open the toolbar, change one style or setting, and confirm keyboard focus remains usable.                                          |
| 6     | Create one representative shape with an attached line, move it, and Undo once.                                                     |
| 7     | Apply one background, zoom once, and switch to Reading View.                                                                       |
| 8     | Install the release candidate and complete one short create, save, and reopen happy path.                                          |

A failed scenario may be repeated after a fix, but it remains the same one phase ID. A phase with no newly visible surface uses its listed no-regression scenario and does not add diagnostic production UI. Release publication approval is a separate governance action and does not count as a sanity scenario.
