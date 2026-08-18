# Testing and Acceptance

## 1. Test Layers

The test tree MUST mirror production package structure under `test/` and include:

- pure domain unit tests;
- property and fuzz tests for geometry, operations, codecs, anchors, and parsers;
- application integration tests for sessions, undo, save generations, conflicts, and recovery;
- adapter contract tests for Obsidian Vault, editor, reading view, settings, and lifecycle boundaries;
- browser tests for toolbar, stylebar, SVG, pointer routing, keyboard, focus, and themes;
- desktop and mobile Obsidian end-to-end tests for critical workflows;
- real-device performance benchmarks.

Tests MUST assert observable contracts rather than internal implementation details. They MUST be deterministic, independent, and free of fixed waits.

## 2. Product Acceptance Scenarios

### 2.1 Native Markdown

1. Open an unannotated `.md` note and verify a `ready`, `unowned`, `unannotated` session whose editable view derives mutable first-command eligibility while Reading View derives read-only access.
2. Type, select, format, undo, redo, invoke the software keyboard, and use Obsidian Properties normally in Cursor mode.
3. Verify that the plugin does not create a Markdown text box or custom renderer.
4. Verify that no sidecar is created until the first annotation command reaches its identity-bound `first-sidecar-pending` transition and the matching revalidated command performs the one permitted create-if-absent.

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

### 2.4 Touch Routing

1. Activate Pen on a phone or touch emulator.
2. Touch an existing shape and verify it becomes selected without a new stroke.
3. Touch and drag empty note content and verify native scroll.
4. Cross the exact 8-CSS-pixel two-finger distance slop from `InputGestureProfileV1` on note content and verify plugin whole-note zoom, while an operating-system accessibility zoom gesture is not intercepted.
5. Draw with a stylus and verify the gesture is claimed by Pen.
6. Right-click without dragging on native Markdown and empty note content and verify Obsidian's native context menu opens without an Inkbook selection or operation.
7. Right-click without dragging on a plugin element and verify the Inkbook target menu opens while the native context menu is suppressed.
8. At 100 percent zoom or with no available pan range, move the secondary button below, exactly at, and above 8 CSS pixels and verify Inkbook does not claim panning.
9. At non-100-percent zoom with an available pan range, move below 8 CSS pixels and verify no panning or premature event suppression.
10. Repeat at exactly and above 8 CSS pixels and verify the shared note surface pans with no context menu, selection change, annotation operation, host-history effect, or sidecar generation.
11. Start the claimed pan on an annotation and verify the annotation itself never moves.
12. Cancel, dispose, and unload during pending and active states and verify pointer capture, listeners, and pending menu state are released.

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

### 2.10 Zoom

1. Zoom from 50 to 400 percent through controls and pinch.
2. Verify Markdown, SVG, selection, background, and hit testing remain aligned.
3. Resize a shape and Table, move a Table divider, and change one axis length at a fixed zoom. Verify every outline, border, divider, axis, grid guide, and cap width remains constant in note units.
4. Verify zoom does not add a host-history effect or alter canonical geometry.

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

### 2.12 Selection Models and Constant-Width Resize

1. Select a Line, Arrow, and Connector. Verify start and end endpoint handles, the applicable Line or Arrow curve handle, no rectangular area frame, geometry-aware hit testing, and an axis-aligned envelope used only for spatial-index broad phase.
2. Select single Pen and Highlighter strokes, every closed shape, and a rotated Table. Verify one geometry-derived rectangular area frame and agreement among preview, commit, hit testing, lasso, and rendered geometry. Verify that transformable `fixed` and `text-position` elements expose their applicable handles, while every `text-range` element derived from fragments or an enclosure envelope exposes no geometry resize or rotate handles and explains the required binding change. Cover range-bound Pens, Highlighters, closed shapes, and Tables. For each transformable stroke, verify unchanged pressure and style, current-token validation without reclassification, exact undo, and disabled scaling on a zero-extent sample axis. Verify width-preserving retained-centerline preview for constant-width strokes and regenerated bounded level-of-detail outlines, with no filled-outline scaling, for pressure-varying Pen strokes. Verify worker-first sample materialization at commit. For each transformable Table, also verify one constrained handle per internal divider and no separately selectable divider element.
3. Select 2D and 3D coordinate systems. Verify one line-like control corridor and positive-end length handle per axis, one shared move target, one rigid-rotation handle, no common area-resize frame, and unchanged axis directions and inter-axis angles during length editing.
4. Resize and rotate every transformable `fixed` and `text-position` Pen and Highlighter stroke, every bounded shape, and every Table; move every Table divider; and change every coordinate-system axis length at 50, 100, and 400 percent whole-note zoom. Verify changed geometry, byte-identical stored style and style revision, unchanged pressure values and note-unit line and cap widths, correct visual scaling from whole-note zoom, exact cancellation, undo, and redo, and no cumulative width or geometry drift after repeated cycles.
5. Move every linear endpoint at the same zoom values and verify unchanged line width, cap size, dash pattern, opacity, color, identity, and unaffected endpoint where applicable.
6. Resize a persisted Group and a transient mixed multi-selection whose members all permit the aggregate geometry transform. Verify one aggregate frame, hidden member-specific handles, one atomic commit, one host-history effect, per-member constant widths, stable group identity, and incremental affected-entry index updates. Add each kind of fragment- or enclosure-derived `text-range` element and verify resize and rotation become unavailable for the complete aggregate with no partial mutation. Separately add visible and offscreen pressure-varying Pens with transformable bindings. Verify a transient transform for compatible members, a single coalesced current worker preview only for mounted pressure-stroke level-of-detail outlines, no direct filled-outline scaling, no offscreen preview generation, exact pressure-outline regeneration at commit, and one width-preserving atomic operation.
7. Cancel every pointer and keyboard transform through Escape and pointer cancellation. Verify exact prior geometry, style, binding, selection, focus, and zero canonical publication, history entry, or sidecar generation.
8. Serialize the resulting scene and verify that no selection frame, handle, control bound, paint bound, index envelope, preview transform, or DOM-derived measurement is persisted.
9. Drag every area handle immediately before, at, and across its opposite limit and verify local-axis projection, fixed-opposite behavior, the shape `0.01` clamp, each Table axis clamp `max(2, 0.01 * priorExtent / priorMinimumTrack)`, no track below `0.01`, no handle flip, correct midpoint center, and no pointer modifier changing the contract. Rotate across `-Math.PI` and `Math.PI` and verify the exact visual-counterclockwise matrix and canonical `-Math.PI` result.

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
- canonical Group records round-trip exactly, while cycles, duplicate children, multiple direct parents, unresolved references, fewer than two children, nesting beyond 32, noncontiguous leaves, or a flattened `childIds` order unequal to the occupied `objectOrder` subsequence fail before scene construction and clipboard admission;
- all closed V1 IDs, discriminators, colors, caps, dashes, styles, geometries, bindings, attachments, component revisions, object-order permutations, and note-appearance records round-trip canonically; unknown values, invalid ID alphabets, duplicate IDs, revision overflow, and cross-kind geometry or style records fail before scene construction;
- `delta-varint-v1` golden fixtures cover positive, negative, and zero deltas, pressure-present and pressure-absent records, one-point strokes, five-byte boundaries, canonical base64url, minimal varints, count and trailing-byte failures, overflow, and deterministic decode-encode equality;
- operation property tests cover every closed patch and atomic batch, exact restoration of all non-revision canonical values, monotonic scene and changed-component generations, a fresh dispatch ID for each Forward, Undo, and Redo, stable retry identity, repeated Undo and Redo, branch-after-Undo without revision ABA, Create or Delete placement semantics, Group leaf-block order equality, dependency-closed delete, Connector endpoint-operation exclusivity, and all-or-nothing rejection;
- connector fixtures cover every valid area and axis port, invalid target kinds and port IDs, pointer distances below, at, and above 12 CSS pixels, distance, z-order, and port-order ties, pointer attach or free placement, keyboard port pick, Detach, cancellation, target move, resize, rotation, Connector-own-binding-first then attached-port replacement order, both-free rigid geometry, independently moving attached targets in two pane widths, current-token target deletion, exact Undo, reverse-index-only invalidation, and the 1,024/1,025 attached-endpoint boundary. Detach and target deletion after moving the Connector's own binding inverse-project the visible port exactly once, produce no doubled offset, and reject stale, ambiguous, or non-invertible projections without mutation;
- clipboard fixtures cover custom MIME and plain-JSON fallback, fresh IDs, current-destination binding inference, keyboard and pointer placement, exact duplicate offset, internal and external connector targets, nested Groups, cut acknowledgement ordering, atomic failure, malicious JSON, unknown versions, and values immediately at and over every payload limit;
- repeated load, detach, and unload leaves no observers, listeners, timers, SVG roots, sessions, or pointer captures.
- recovery append fails from quota, transaction abort, disposal, and backend loss before publication, leaving scene and history unchanged;
- the production IndexedDB recovery adapter passes schema creation, upgrade, atomic compare-and-swap, abort, quota, corruption, restart, concurrent-session, exact byte-accounting, deletion, and idempotent disposal tests in every supported desktop, iOS, and Android compatibility cell; unavailable or non-transactional storage keeps annotation mutation read-only;
- a crash after `prepared` persistence but before durable `host-recorded-forward` acknowledgement never auto-replays and leaves the scene unchanged;
- a crash after durable `host-recorded-forward`, `host-recorded-undo`, or `host-recorded-redo` acknowledgement but before scene publication restores only that recorded direction exactly once;
- host-recorded replay succeeds only when the current durable source generation and exact Markdown digest match the attempt; a changed digest with otherwise matching sidecar and scene state publishes nothing and enters bounded reattachment or review;
- failure to persist a `host-recorded-*` transition leaves the scene unchanged, makes the already admitted host effect visibly inert, and never guesses or auto-replays a direction;
- a completed forward save removes its recovery attempt while preserving the actionable host effect; a later Undo and Redo each create a new monotonic bounded direction attempt, survive a crash exactly once, and remove only their own attempt after save acknowledgement;
- repeated save, Undo, save, Redo, and save cycles remain within the 8 MiB per-note recovery budget and 32 MiB per-pane history-payload budget without retaining completed attempts;
- a source transition from G0 to G1, a host-recorded annotation attempt admitted at G1, and a later transition from G1 to G2 recover in total `SessionOrder`: the attempt applies at its unique G1 node, every introduced or replaced binding maps through the remaining G1-to-G2 suffix, and replay at G0 or G2 is rejected;
- acknowledging save S1 atomically removes exactly its covered attempts and checkpoints and rebases every retained direct-successor attempt and checkpoint from the expected prior base to the acknowledged replacement base; a gap, fork, stale base, missing covered identity, or conflicting successor aborts cleanup and publishes no acknowledgement;
- recovery before the first `Vault.create()` uses only the `absent-first-sidecar` load variant, validates null sidecar base, expected path, current Markdown evidence, pending identity, and matching host-recorded Forward, then creates revision 1 exactly once; a prepared-only, mismatched, collided, or already-existing case creates nothing;
- a durable source checkpoint rebases every anchor-bearing prior and replacement value in each actionable history entry while preserving its stable history identity; later Undo and Redo restore the mapped values exactly, while an unsafe or partial rebase blocks further annotation mutation;
- plugin unload or editor disposal while the host could still emit an Inkbook effect either proves that effect unreachable or restores its complete actionable history entry, lifecycle, owner lease, epoch, and accepted host-sequence high-water mark before accepting it; otherwise the cell fails closed and a late effect cannot mutate the scene;
- the chosen sync configuration transfers both `.md` and `.inkbook.json`, while an excluded or missing sidecar produces visible drift and never an empty replacement;
- conflict-copy names collide, the three-copy cap is reached, and no existing conflict copy is overwritten or automatically removed;
- deleting a connector target disconnects at its last resolved endpoint and undo restores target plus attachment exactly;
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
- parent-folder and configured-root renames rekey every affected loaded session, resolved-sidecar identity, YAML locator, device-local zoom key, and recovery key through bounded indexed work, update every loaded sidecar's embedded Markdown path and storage layout through compare-and-swap, and lazily validate plus repair an unopened located sidecar on next open through target-aware local prefix rules, all without a Vault-wide scan; tests cover adjacent and `vault-root` layouts, `A` to `B` to `C`, the valid inverse `A` to `B` to `A`, reuse of a new unrelated `A` after an older `A` to `B`, overlapping parent and child renames, complete-segment matching, local generation order, longest-prefix tie-breaking, restart between moves, zero and multiple target paths, corrupt non-increasing or ambiguous rules, duplicate child-event filtering, durable-cursor resume, unrelated-folder no-ops, two installations with different storage defaults plus synchronization in both directions, and adversarial branching fixtures immediately at and above the 128-rule, 32-hop, 4,096-state, 8,192-transition, 1-MiB, 100-ms desktop or tablet, and 250-ms mobile limits with deterministic read-only exhaustion;
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
- endpoint, cap, curve, and connector geometry;
- Line and Arrow quadratic curve handles, curve bounds, hit testing, cancellation, exact undo, and underline-binding revalidation;
- Table, 2D axes, and 3D axes semantic geometry, composed paths, whole-object selection, limits, transforms, persistence, and inverse patch values;
- spatial-index insert, update, remove, and query equivalence against brute force;
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

Visual regression tests SHOULD use small deterministic SVG fixtures in Obsidian default light, default dark, and host forced-colors or high-contrast mode where exposed. Pixel tests require explicit tolerances and cannot replace semantic assertions.

## 5. Accessibility Tests

Automated and manual checks MUST verify:

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

## 6. Performance Acceptance

The benchmark fixture and budgets in [Quality and Performance](09-quality-and-performance.md) and [SVG Rendering](06-svg-rendering.md) MUST pass on the named release device matrix.

The harness MUST measure input-to-preview, next-presented-frame latency, browser paint and compositor duration where exposed, dropped frames, single-object selection and resize, Table-divider and axis-length edits, geometry-aware hit testing, Select All, whole-note lasso, aggregate resize preview and commit with and without pressure-varying Pens, aggregate undo and redo, scroll, zoom, culling, background-region derivation, binding inference, text-range projection, enclosure projection, anchor reflow, first overlay, cold full-scene encoding, warm save, bulk-transform save, source-checkpoint queue wait, mapping composition, digest work, `RecoveryStore` append, first durable checkpoint publication, sidecar parse, full mutation readiness, and unload cleanup. It MUST additionally measure annotation recovery preparation plus durable `host-recorded-*` transition as one end-to-end phase while retaining preparation and transition as diagnostic component timings. Every measured metric references one explicit stable `PERF-10K-*` table-row ID from [Quality and Performance](09-quality-and-performance.md); name-based fallback is forbidden. `Input-to-preview` and `first overlay` end only after the applicable projection is visibly presented, not when JavaScript or DOM mutation merely finishes. The harness MUST detect long tasks and retained DOM or heap growth across 50 open-close cycles.

Cold means no decoded scene, index, or geometry cache exists for the note. Warm means the note session and unchanged encoded chunks remain available. The capacity suite runs deterministic 5,000- and 10,000-element fixtures, each with exactly one valid binding per element, dispersed and dense visible-cluster variants, recorded digests, and verified encoded sizes within all sidecar limits. Save benchmarks report encoding, Vault operation, and acknowledgement phases separately. Last-view detach reports synchronous disposal separately from any recovery-protected asynchronous flush.

The capacity suite MUST verify that the 5,000-element tier passes every applicable desktop, tablet, and phone budget and that the 10,000-element stress tier passes every predeclared p95, p99, maximum, steady-heap, peak-heap, frame, slicing, correctness, and full-interactivity threshold. It includes selection and resize of one visible shape or Table, one Table-divider edit, one coordinate-system axis-length edit, plus aggregate operations over 100, 1,000, 5,000, and 10,000 selected members. No passing run may scan or rebuild the complete scene for a single-element operation. The versioned benchmark manifest is frozen before measurement and a missing or retrospectively changed threshold fails the run.

Framework profiling MUST verify zero React note-root commits and zero per-element React renders during pointer sampling, gesture preview, Table-divider movement, axis-length movement, scroll, pure zoom, culling, retained-node updates, selection-chrome updates, and worker progress. Tool, style, and selection-summary changes may commit only the subscribed toolbar, stylebar, menu, or status subtree. A 10,000-element scene MUST NOT create 10,000 React component instances. Release counts come from an instrumented production profiling build; development-only Strict Mode behavior is reported separately and cannot replace release evidence.

Re-entrancy tests MUST make scene, selection, status, and worker-completion listeners synchronously request additional work. The note session queues or coalesces those requests, preserves total command order, publishes each accepted command exactly once, and never produces recursive publication, render loops, duplicate history, or duplicate save generations.

Worker contract and performance tests MUST cover every `WORKER_ADMISSION_V1` boundary immediately below, at, and above its threshold, plus normal completion, priority, cancellation, stale revision, queue and byte-budget exhaustion, worker crash, plugin unload, transferable-buffer ownership, canonical-buffer non-detachment, and the sliced fallback when workers are unavailable. On a conforming worker platform, every admitted pure phase runs off the main thread except for bounded request packing and final publication. The fallback executes at most 2 ms per active-interaction slice and 4 ms per idle slice without partial canonical state or fixed waits.

## 7. Coverage and Traceability

Every normative requirement MUST map to at least one automated test ID or an approved, versioned manual acceptance procedure. The checker parses every indexed `docs/**/*.md` file as CommonMark with GitHub tables. A direct clause is one paragraph, one leaf list item excluding its nested list, or one table body row that contains `MUST`, `MUST NOT`, `SHALL`, `SHALL NOT`, `SHOULD`, or `SHOULD NOT` as an uppercase text token. In addition, every leaf item in a list immediately introduced under the same heading by a direct clause ending in a colon is an inherited clause even when it omits the token. Every body row in a table immediately introduced under the same heading by a direct normative clause is an `inherited-table-row` clause even when the row omits a normative token. Every numbered step below `Product Acceptance Scenarios`, every leaf item below `Persistence and Fault Tests` or `Obsidian Host Contract Acceptance`, and every item below a Roadmap `Deliverables` or `Exit evidence` heading is an inherited clause. Roadmap items under `Required specifications` are dependency references and are not requirement clauses unless they independently satisfy the direct-clause rule. Outside `12-toolbar-mockup.md` and `13-references.md`, a fenced block immediately following a paragraph, list item, or table row makes that preceding block a `fenced-contract` clause when it is not already direct or inherited; the code is appended verbatim in every case. Direct, inherited, then fenced-contract precedence ensures one block receives one ID. Headings, examples without one of these rules, the toolbar mockup, and reference lists are non-normative unless their prose contains a normative token.

The canonical project-relative path uses forward slashes and Unicode NFC. The owning heading path is the NFC plain-text content of all ancestor headings joined by `/`. Inline formatting is removed, code-span content is retained literally, and a link contributes its visible label plus normalized destination. Paragraph and list text convert CRLF or CR to LF, normalize to NFC, collapse every Unicode whitespace run to one ASCII space, and trim. A table row joins similarly normalized cells with U+001F. Appended fenced code normalizes line endings to LF, preserves every other byte, and omits the fence delimiter. The clause kind is `paragraph`, `list-item`, `inherited-list-item`, `acceptance-step`, `fenced-contract`, `table-row`, or `inherited-table-row`. Its duplicate occurrence is the one-based count of the same kind and canonical clause text under the same heading among preceding clauses.

The hash input is UTF-8 over five NUL-separated fields in this exact order: canonical path, heading path, clause kind, decimal duplicate occurrence, and canonical clause text including any appended code. NUL in an input field is invalid. The requirement ID is `REQ-` plus the first 20 lowercase hexadecimal characters of SHA-256. Any full or truncated collision between unequal canonical inputs fails generation. A changed clause intentionally receives a new identifier.

The checked-in `test/traceability/requirements.json` records generator version, specification digest, and for every clause its ID, path, heading path, kind, occurrence, full SHA-256, and canonical-text SHA-256. Automated test metadata records a stable `TEST-*` ID and a non-empty requirement-ID array. Manual evidence conforms to `test/manual/manual-acceptance.schema.json` and records a stable `MANUAL-*` ID, procedure version, requirement IDs, exact artifact and compatibility cell, operator, timestamp, steps, result, and evidence paths. CI regenerates the manifest byte-for-byte, rejects stale, duplicate, unknown, or uncovered IDs, and permits no unversioned free-text waiver.

A feature is incomplete when it has neither automated verification nor an approved manual procedure explicitly permitted by this document.

## 8. Obsidian Host Contract Acceptance

The following tests are release-blocking and use the declared minimum plus selected release Obsidian versions:

### 8.1 Package and Compatibility

- validate canonical plugin ID `inkbook`, folder-ID equality, Community ID and display-name uniqueness, permitted display-name characters, real author presence, description length, punctuation and content, SemVer version, `minAppVersion`, `isDesktopOnly: false`, and conditional author or funding URLs;
- reject a manifest-tag mismatch, missing `main.js`, `manifest.json`, or `styles.css`, development bundle, sample scaffold, and transitive Node.js, Electron, native-module, or remote-code dependency;
- when `minAppVersion` changes, verify root `versions.json` selects the newest compatible plugin release and rejects malformed or impossible mappings;
- load the production package in a dedicated test Vault on minimum desktop, iOS, and Android, reload the plugin after build changes, and verify startup, disable, enable, and unload;
- prove that every imported Obsidian API exists at the declared baseline or follows its tested guarded fallback.
- validate the versioned compatibility-matrix manifest against its schema and require an exact Obsidian version, platform, OS build, device model or desktop hardware profile, imported API set, expected capability, and guarded fallback outcome for every release cell;

### 8.2 Startup and Lifecycle

- instrument `onload()` and verify it performs no Vault enumeration, sidecar parse, scene construction, worker creation, whole-view measurement, or recovery scan;
- fire Vault `create` before and after layout readiness and verify pre-ready work returns while post-ready owned work remains bounded;
- unload before and during the non-disposable `onLayoutReady()` callback and verify the invalidated lifecycle token blocks every side effect, registration, and asynchronous continuation;
- create and dispose every view, section, menu, modal, observer, timeout, animation frame, interval, worker, port, framework root, pointer capture, and session owner, verifying child-before-parent and idempotent teardown;
- disable the plugin during startup, open, gesture, worker work, save, Reading View reprocessing, and pop-out migration and verify no callback publishes after disposal;
- statically and dynamically verify that production code does not depend on global `app`, `window.app`, or the global document or window for view-owned work.
- extract and inspect the build-time worker payload from `main.js`, launch it through the packaged adapter on desktop, iOS, and Android, verify the chosen local URL or Blob mechanism is permitted, and prove that no fourth release artifact or remote execution path is required.

### 8.3 Workspace and Views

- open Live Preview, Source, and Reading View, then verify one correct view adapter per concrete leaf and host view and one shared canonical note session for panes of the same file;
- open a Bases file and non-Markdown leaves and verify no Inkbook toolbar, overlay, sidecar discovery, YAML marker, Ribbon action, status-bar item, custom `ItemView`, or replacement leaf is created;
- replace, detach, relink, change mode, and change file in a leaf and verify only the corresponding view-local owner is disposed or rebound;
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
- perform a plugin-originated Markdown change and verify one native editor transaction and one host-history event, while an associated annotation operation contributes its own immediately ordered invertible effect without changing Markdown.

### 8.5 Reading View

- process several sections, detach and reprocess them in different orders, and verify one whole-note overlay, one child owner per reported section, no duplicate observer or region, and exact section-generation replacement;
- exercise every toolbar, stylebar, handle, context-menu, clipboard, hotkey, and command entry point in Reading View and during a concurrent mode change, verifying final mode revalidation, accessible disabled state, and zero Markdown, scene, history, recovery, or sidecar mutation;
- verify source mapping uses documented processor context and bounded evidence, never rendered DOM order alone;
- remove or corrupt source evidence and verify degraded read-only placement with no guessed canonical binding;
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

### 8.8 Mobile and Release

- verify the private-development repository settings, labels, least-privilege workflow permissions, Dependabot schedules and grouping, required check names, `Protect main` and `v*` rulesets, SHA-pinned direct actions, gitleaks checksum verification, three-day temporary artifacts, and draft-release behavior against [Repository and CI Governance](17-repository-and-ci-governance.md);
- seed dependency minor, patch, and major update fixtures and verify grouped minor or patch auto-merge waits for `CI`, `gitleaks`, and `Validate PR Title`, majors remain separate and manual, every squash title is Conventional Commit compatible, and no docs-only pull request remains indefinitely pending;
- run real-device touch, stylus, software-keyboard, background, overlay, worker, sliced-fallback, storage, reload, and memory cases on named iOS and Android devices; desktop mobile emulation does not satisfy this requirement;
- execute the production bundle with absent desktop globals and reject unsupported syntax, including RegExp lookbehind without the declared and tested platform support plus fallback;
- verify README disclosures, local-only runtime data flow, sidecar synchronization warning, independent third-party status, license, provenance, and Community policy compliance against current official rules;
- query official stable release channels immediately before the release-candidate freeze, verify Node.js active LTS, npm, every direct dependency, every quality tool, and every CI action or build runtime use the newest stable mutually compatible releases, verify each supply-chain-sensitive action resolves from its reviewed immutable digest, and block rather than silently retain an older version when compatibility fails;
- build a draft release with `npm ci` from the resulting reviewed lockfile, record every exact resolved version, require exact tag and manifest version equality, attach the three loadable artifacts, verify any compatible-version fallback, and manually approve publication;
- verify the first present package script in Community scanner order `build`, `build:plugin`, `compile` runs the production plugin build;
- verify no runtime self-install, self-update, executable download, obfuscated behavior, undisclosed network access, telemetry, or first-party Obsidian claim exists.
