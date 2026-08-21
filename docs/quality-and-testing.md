# Quality, Performance, Animation, and Testing

## Quality Priorities

When requirements compete, use this order:

1. prevent data loss and unsafe file handling
2. preserve live input responsiveness
3. preserve correct geometry and history
4. provide smooth, understandable transitions
5. reduce background CPU, memory, and file size
6. add optional visual polish

No animation, abstraction, or background task may degrade live ink input.

## Performance Acceptance Dataset

The standard large-document fixture contains:

- 10,000 freehand pen strokes
- 500,000 total stroke points, with realistic variation from 1 to 500 points per stroke
- 500 additional mixed shapes, including coordinate systems and tables
- 500 lines and arrows with endpoint connections distributed across shapes, including one target at the 512-endpoint limit
- a derived page height of at least 200,000 page units
- a mix of portable Theme text and fixed-color styles
- selected content in and outside the viewport
- adversarial long strokes and large shapes that enter the spatial-index overflow collection

The stress fixture contains the maximum supported 15,000 strokes and 2,000,000 points. It is used for bounded-load and failure behavior, not for the interactive frame budgets below.

The dense-viewport fixture contains 2,500 simple paths whose exact conservative bounds all intersect the reference viewport, with alternating highlight and content membership, fixed overlapping ranks, 100 predetermined hit points, and enough entrants to exceed both normal mounted-node budgets. Its version-controlled expected data contains the exact unique visible-ID sequence in back-to-front band order. After camera motion stops and no pointer is active, reconciliation MUST equal that sequence with no omission, duplicate, or rank change within 30 submitted frames and 500 milliseconds on desktop or 60 submitted frames and 1,000 milliseconds on mobile, whichever limit is reached first. A hit on a visible but not-yet-mounted element promotes that element by the next submitted frame without changing final order.

## Reference Profiles

Performance is measured on both profiles:

| Profile | Minimum class                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop | 4 physical CPU cores, 8 GiB RAM, integrated graphics, 60 Hz display, current supported Obsidian desktop                                   |
| Mobile  | 2021-or-newer mid-range iOS or Android device, 6 GiB RAM where the platform exposes RAM, 60 Hz display, current supported Obsidian mobile |

Every release report records the exact devices, OS versions, Obsidian versions, document fixture hash, build mode, and measurement method. Production builds are required.

## Measurement Protocol

Production builds use a 1,200 by 800 CSS-pixel desktop viewport and a 390 by 700 CSS-pixel mobile viewport at 60 Hz, width-fit zoom, a centered viewport at 50 percent of page height, and the same version-controlled fixture hash. Each release names one exact desktop and one exact mobile reference device meeting the minimum classes; changing a device creates a new recorded baseline and requires one comparison run on the previous device when available.

Each scenario has one warm-up run followed by five measured runs. Duration and sample counts are minimums:

| Scenario                   | Script and timing endpoints                                                                                                                                                                     |                                      Samples per run |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------: |
| Unlock                     | Preview activation event to the first frame with measured editor, visible committed content, toolbar ready, and input listener enabled                                                          |                                           20 unlocks |
| Draw                       | 30 seconds of 120-Hz synthetic pointer samples in viewport-local sine strokes; event timestamp to live-path attribute update                                                                    |                                        3,600 samples |
| Maximum stroke             | One 4,096-point pressure stroke; each retained sample to bounded-tail update, then release to committed-path handoff                                                                            |                                           20 strokes |
| Erase                      | 30 seconds of sweeps across 50 visible and indexed offscreen candidates; frame start to paint submission                                                                                        |                                         1,800 frames |
| Pan and zoom               | Alternating horizontal pan and anchored zoom for 30 seconds; animation-frame start to submitted DOM updates                                                                                     |                                         1,800 frames |
| Viewport reconciliation    | Small scroll steps and alternating full-viewport jumps; invalidation to entrant, exit, and changed-node mutations                                                                               |                                         1,800 frames |
| Transform                  | Move and rotate a 100-element visible selection for 30 seconds, then repeat with all 10,000 strokes selected and only the bounded preview subset mounted                                        |                                    1,800 frames each |
| Query and commit           | Fixed hit-test points, eraser segments, one-stroke commits, and the 10,000-element transform commit                                                                                             |  500 operations, or 50 for the full-selection commit |
| Snap and connection update | Fixed endpoint drags through dense anchor candidates, then move, scale, and rotate the 512-endpoint target                                                                                      |                    500 queries and 100 target frames |
| Arrange                    | All four order operations on fixed single selections and an alternating 5,000-element selection in a 10,000-element band                                                                        | 500 operations, or 50 for large-selection operations |
| Export                     | Worker request post to validated result receipt, excluding vault I/O                                                                                                                            |                  20 full and 100 incremental exports |
| Clipboard codecs           | Worker encode and decode of the 5,000-element, 500,000-point clipboard-limit fixture, including delta synchronization, ID remapping, placement, validation, and main-thread adoption            |                              20 copies and 20 pastes |
| Save latency               | One standard-fixture commit with production worker and local-vault adapters; debounce expiry to latest revision confirmation                                                                    |                                             20 saves |
| Save backpressure          | One commit through its 500 ms dispatch, then four commits 50 ms apart while 300 ms worker and 300 ms vault delays are active; request counts, queue depth, retained results, and final revision |                                         50 sequences |

Frame data is collected with `requestAnimationFrame` timestamps and Long Animation Frame data when available. Input latency uses event timestamps and a mark immediately after the live DOM mutation. Each run reports p50, p95, p99, maximum, missed-vsync rate, and longest consecutive missed-vsync sequence; the release result is the worst measured run, not a percentile pooled across runs.

Memory is additional heap compared with the same Obsidian pane and locked preview. Record retained and peak live heap from unlock start through worker parsing, migration, buffer transfer, fixture indexing, one full scenario cycle, maximum clipboard Copy and Paste codecs, full export, result handoff, `Vault.process()`, conflict recovery, five rapidly coalesced incremental saves, and five idle seconds. The ceiling applies throughout, including parsed input, editor and worker geometry, clipboard representations, indexes, fragments, prepared output, current vault input, and animation tombstones. Use an explicit development-tools garbage collection only when supported and record that fact; otherwise take three stable heap readings one second apart and use the maximum. The test fails if the ceiling or an unexplained upward trend across five repeated cycles is observed.

## Performance Budgets

The 10,000-stroke fixture MUST satisfy:

| Operation                                                                          |                                               Desktop |                                                Mobile |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------: | ----------------------------------------------------: |
| Plugin startup with no active embed                                                |                        at most 25 ms main-thread work |                        at most 40 ms main-thread work |
| Locked preview React mounts                                                        |                                                     0 |                                                     0 |
| Unlock to first interactive frame, p95                                             |                                        at most 750 ms |                                      at most 1,500 ms |
| Main-thread work caused by worker-backed unlock in one frame                       |                                          at most 8 ms |                                         at most 12 ms |
| Worker clipboard codec at the clipboard limit, p95                                 |                                        at most 750 ms |                                      at most 1,500 ms |
| Main-thread work caused by one worker clipboard operation in one frame             |                                          at most 8 ms |                                         at most 12 ms |
| Pointer sample to live-path DOM update, p95                                        |                                          at most 8 ms |                                         at most 16 ms |
| Scroll-owner `clientWidth` change caused by pen contact                            |                                          0 CSS pixels |                                          0 CSS pixels |
| Interaction frames meeting one 60-Hz refresh interval                              |                        at least 99 percent at 16.7 ms |                        at least 99 percent at 16.7 ms |
| Interaction frame time, p99                                                        |                                       at most 16.7 ms |                                       at most 16.7 ms |
| Longest consecutive missed refresh intervals                                       |                                             at most 1 |                                             at most 1 |
| Hit test or eraser candidate query, p95                                            |                                          at most 8 ms |                                         at most 12 ms |
| Command commit excluding export, p95                                               |                                         at most 12 ms |                                         at most 20 ms |
| 10,000-element uniform transform commit, p95                                       | at most 100 ms, chunked after immediate visual commit | at most 200 ms, chunked after immediate visual commit |
| Worker SVG export after a full snapshot, p95                                       |                                        at most 750 ms |                                      at most 1,500 ms |
| Incremental worker export after one stroke, p95                                    |                                        at most 100 ms |                                        at most 200 ms |
| Main-thread work caused by autosave in one frame                                   |                                          at most 8 ms |                                         at most 12 ms |
| Debounce expiry to latest revision save confirmation with production adapters, p95 |                                      at most 2,000 ms |                                      at most 4,000 ms |
| Additional plugin memory while active                                              |                                       at most 200 MiB |                                       at most 140 MiB |
| Mounted content paths in a normal viewport                                         |                                         at most 1,200 |                                           at most 900 |
| Mounted SVG nodes in a normal viewport                                             |                                         at most 2,000 |                                         at most 1,500 |
| Compact snapshot metadata for the standard fixture                                 |                                        at most 32 MiB |                                        at most 32 MiB |
| Complete SVG for the standard fixture                                              |                                        at most 48 MiB |                                        at most 48 MiB |

Additional rules:

- No input-related main-thread task may exceed 16.7 ms. The chunked 10,000-element transform commit may span multiple tasks, but each slice obeys this limit and the already rendered transform remains visually stable.
- No pointer sample supplied by `getCoalescedEvents()` may be silently dropped. Nearby samples may be deterministically merged by the documented path builder.
- Unlock, pan, zoom, and drawing must not mount all 10,000 strokes.
- Background generation, bounds updates, spatial-index updates, and cache invalidation must be incremental.
- Camera-only, overlay-only, and theme-only frames perform zero committed-content attribute writes. Paint-only and order-only commits perform zero path construction, bounds calculation, anchor generation, or spatial-index mutation.
- Snap lookup uses the spatial index, and target transforms use the reverse connection map. Neither may scan the complete element store.
- A synchronous document-worker fallback may exceed the corresponding worker duration, but it MUST yield between chunks so no main-thread slice exceeds 8 ms desktop or 12 ms mobile and MUST pause while a live gesture is active.
- Autosave timers do not count as permission to perform work during an active gesture.
- Save latency reports worker computation, message handoff, string adoption, conflict checks, and host I/O separately. No main-thread preparation or adoption slice may exceed the autosave frame budget.
- A standard-fixture size report records total bytes, metadata bytes, static-markup bytes, and bytes per stroke point. Pretty-printed output fails regardless of the total.

## Performance Architecture Rules

- Locked embeds use the static SVG preview and mount no editor store or React tree.
- The runtime store is a private ID map plus two ordered ID bands and a derived rank map. Ordinary commands replace changed immutable records only and publish one atomic delta; they do not clone the complete map, a complete band, or a persisted snapshot.
- Viewport queries, hit testing, erasing, and page extent queries use the spatial index.
- React owns application chrome and coarse editor state only. Individual ink elements are owned by the imperative SVG scene renderer.
- Pointer-move, pan, zoom, pinch, scroll, snapping, culling, and preview frames produce zero React renders, React state updates, and React-visible store notifications. Discrete selection and tool changes may enqueue one coarse UI update after imperative feedback.
- Pointer-move processing never clones the complete element array or snapshot.
- The live-stroke builder appends finalized chunks and rebuilds at most 16 retained samples plus their boundary segment; the 4,096th point does not reconstruct the first segment.
- Selection transforms preview with one parent SVG transform when possible and commit geometry once.
- Selection size never disables culling: visible selected content and a maximum 256-path active subset are mounted, while offscreen selection uses aggregate bounds.
- Bounds, paths, and semantic anchors validate the element ID plus its commit-time `geometryVersion`. Paint, order, selection, and theme changes are cache hits. Main-thread path strings are limited to mounted nodes plus the bounded recently-unmounted cache; unlock does not generate all document paths.
- Viewport invalidations coalesce into one pending animation-frame update. Visible-ID diffing mutates only entrants, exits, changed records, and affected order; scene groups are never replaced wholesale.
- Visible-set reconciliation uses stable numeric slots, reusable buffers, and epoch markers or bitsets. An ordinary frame allocates no replacement full candidate, visible, entrant, exit, or deduplication collection.
- Committed paths and decorative overlays use `pointer-events: none`; one presentation-owned focusable input surface handles the canvas. No SVG content node owns an event listener.
- Applied-node state suppresses unchanged SVG attributes. Geometry, paint, order, connection, visibility, camera, overlay, background, and theme dirtiness remain independently observable in renderer instrumentation.
- Each scene frame completes layout reads before DOM writes. Repeated observers and unchanged dimensions schedule no work.
- Document-worker state synchronization contains changed and removed IDs, order, and page state after initialization; it atomically advances `modelRevision` and fragment dirtiness, while clipboard encoding uses selection IDs rather than a complete selection clone.
- Order-only changes carry explicit render-band order, and target changes carry every automatically re-resolved line or arrow.
- The newest dispatched export generation orders only replaceable export results and `preparedSuccessor`. Once admitted, `activeSaveOperation` remains valid through mandatory read-back even when a newer export is dispatched. Other worker jobs have independent operation IDs; queued timers have no identity.
- At most one export request, one non-replaceable active save, one prepared successor, and one vault write are in flight. Later commits occupy one coalesced target, vault writes are serialized, and superseded prepared outputs are released.
- Worker state retains one canonical typed geometry buffer per stroke plus bounded current per-element snapshot and static-SVG fragments. Main-thread and worker allocation together remains inside the memory ceiling.
- One document worker runs one bounded non-preemptive queue. It performs unlock validation and migration, clipboard codecs, SVG export, hashing, preflight, and read-back verification, but receives no DOM, pointer, scroll, camera, spatial-index, React, or Obsidian API object.
- Worker failure invalidates the worker epoch and switches once per session to equivalent input-aware main-thread slices under a new epoch; it does not recreate a worker or retry partial results in a loop.
- Background patterns cover only the visible vertical range plus one viewport of overscan.
- Background geometry is one compound path keyed by aligned visible indices and regenerates only when that key changes. Theme changes reuse its geometry.
- Culling overscan is exactly 80 screen pixels converted to page units at the current zoom.
- Dense viewports eventually mount every exact visible element in input-aware batches; they may disable animation and prewarming but may not rasterize, merge, or hide editable content.
- Every cache has an entry or byte limit, releases removed records immediately, and is released on editor unmount.

## Animation Tokens

```ts
const motion = {
  fast: 120,
  standard: 180,
  erase: 160,
  layout: 240,
} as const;

const easing = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  emphasized: "cubic-bezier(0.2, 0, 0, 1)",
} as const;
```

Durations are milliseconds. A single easing curve is intentional and keeps the motion system small.

## Animation Contract

Every user-visible state change animates unless listed as immediate or reduced motion is active.

| Transition                                           |                                      Duration | Properties                                                   |
| ---------------------------------------------------- | --------------------------------------------: | ------------------------------------------------------------ |
| Toolbar enter or exit                                |                                        180 ms | opacity, translateY                                          |
| Tool active state                                    |                                        120 ms | background color, foreground color, scale                    |
| Flyout open or close                                 |                                        180 ms | opacity, translateY, scale                                   |
| Selection handles enter or exit                      |                                        120 ms | opacity, scale                                               |
| Eraser pending-removal feedback                      |                                        160 ms | opacity                                                      |
| Committed shape or pasted-element entrance           |                                        120 ms | opacity, scale from 0.96 to 1                                |
| Delete, Cut, or command-removal exit                 |                                        120 ms | retained visual tombstone opacity, scale to 0.96             |
| Background type or spacing change                    |                                        180 ms | old/new background crossfade                                 |
| Color, opacity, width, fill, or outline-style change |                                        120 ms | supported property interpolation or old/new path crossfade   |
| Locked to active height                              |                                        240 ms | container height with scroll compensation                    |
| Active to locked height                              |                                        240 ms | container height with scroll compensation                    |
| Unlock preview-to-editor crossfade                   |  final 120 ms of the 240 ms layout transition | opacity                                                      |
| Lock editor-to-preview crossfade                     | 120 ms after the exact saved preview is ready | opacity                                                      |
| Automatic page growth or shrink                      |                                        180 ms | container height with scroll compensation                    |
| Overflow edge gradient                               |                                        120 ms | opacity                                                      |
| Conditional toolbar control enter or exit            |                                        120 ms | opacity, scale, width                                        |
| Arrange result                                       |                                        120 ms | old/new path opacity crossfade where overlap changes visibly |
| Snap candidate marker enter or exit                  |                                        120 ms | opacity, scale                                               |

Implementation rules:

- Opacity and transforms are preferred because they avoid layout and paint work.
- Height animation is permitted only for the single background container. Measure start and end heights once. Prefer a compositor visual transition with one final layout commit when host layout permits; otherwise animate the explicit height only while it continues to meet the interaction frame budget.
- Scroll compensation, camera transform, overlay geometry, and container height update in the same animation frame.
- Unlock keeps the locked preview visible until a hidden editor is mounted and measured. It then animates height for 240 milliseconds and crossfades preview to editor during the final 120 milliseconds. Input is enabled and the preview unmounted after completion.
- Lock disables input immediately and runs the 240-millisecond width-fit and height transition concurrently with saving. If saving takes longer, the disabled editor waits at locked geometry. Once the exact saved preview is ready, an independent 120-millisecond editor-to-preview crossfade runs before unmount.
- Automatic page growth starts only after a committed geometry change, except for the bounded one-buffer-unit selection edge-drag extension. That exception may retarget only after the preceding 180-millisecond height transition completes, never on every pointer sample.
- A new input gesture immediately completes or cancels any automatic height, tool, or flyout animation that would delay handling, applies its correct final layout and scroll compensation, and then handles the gesture in the same frame.
- Live ink paths, eraser sweeps, and selection transform previews update immediately and are never tweened behind the pointer.
- Connected endpoints update with their target in the same live frame and are never tweened behind it.
- Committing a live stroke or gesture transform is immediate because the committed path exactly replaces an already visible preview. It MUST NOT flash, fade, or move during handoff.
- Undo uses the inverse transition of its command; Redo uses the forward transition. Reinserted or removed geometry uses the 120-millisecond entrance or exit. Move, scale, rotate, bend, and axis edits interpolate their preview transform from current to restored geometry over 120 milliseconds, then materialize the exact target.
- Model removal is atomic. An exit animation uses a non-interactive visual tombstone that is excluded from hit testing, bounds, history, export, and accessibility state.
- Any discrete user-visible UI or canvas change not named in the table uses the 120-millisecond opacity fallback. Immediate behavior is permitted only for live input, exact preview-to-commit handoff, focus and accessibility state, reduced motion, or a recovery action whose delay could risk data.

## Reduced Motion

When reduced motion is active:

- all non-essential durations become 0 ms
- height, camera, and preview state changes apply in one frame with correct scroll compensation
- focus movement, notices, visibility, and final geometry remain unchanged
- no information may depend on animation alone

## UX Acceptance

- Unlock and lock show no empty, unmeasured, stale, or half-rendered frame.
- Controls never change hit-target size between normal, hover, active, and focus states.
- Conditional toolbar controls do not overlap or cause repeated layout-stage oscillation.
- Every destructive action has confirmation where documented and preserves undo when possible.
- Every failed operation leaves a clear next action such as Retry, Reload, Save copy, or Cancel.
- Cursor, selection handles, eraser radius, and toolbar controls remain screen-sized across zoom levels.
- Animation starts from the currently rendered state when interrupted and never jumps back to an earlier state.

## Accessibility Acceptance

The editor targets WCAG 2.2 AA within the capabilities of the Obsidian host.

- Every icon-only control has an accessible name and tooltip.
- The canvas input surface is keyboard-focusable, has an accessible name, and shows a visible `focus-visible` indicator without changing document geometry.
- The toolbar exposes one `toolbar` role and three labelled groups.
- Tool buttons expose pressed or selected state. Flyout buttons expose expanded state and their controlled popup.
- Tab enters and leaves the toolbar. Arrow keys move within the current group. Home and End move to group boundaries.
- Escape closes the current flyout, cancels an uncommitted gesture, or clears selection in that order.
- Focus returns to the trigger when a flyout closes and moves to the nearest surviving control when a conditional button disappears.
- Keyboard commands exist for every toolbar action that is not inherently pointer-geometric.
- Arrange actions are keyboard-command accessible through Obsidian command registration and have no default hotkeys.
- The Context Menu key and `Shift+F10` open the native canvas menu, whose close operation returns focus to the canvas surface or invoking control.
- Focus indicators, icons, text, active states, selection outlines, and gradients meet applicable contrast requirements in light and dark themes.
- Touch targets are at least 44 by 44 CSS pixels even when the visual icon is smaller.
- Notices and confirmations are announced through the host's accessible UI.
- Canvas element manipulation remains primarily graphical in version 1, but Delete, Cut, Copy, Paste, Undo, Redo, and style changes are keyboard-operable for the current selection.

## Automated Test Strategy

The project uses Unit and Integration tests only. End-to-end tests and smoke tests are explicitly out of scope.

### Unit Tests

Unit tests cover pure or isolated behavior:

- schema validation, limits, deterministic serialization, and migrations
- safe-preview path-token validation, command arity and arc flags, finite numeric paint attributes, per-path and total static-complexity limits, and rejection of malformed, exponent, extreme, or over-budget values before DOM creation
- flat stroke-triple validation, canonical numeric rounding, negative-zero normalization, and runtime-buffer conversion
- geometry, curve extrema, rotated bounds, page extent, and spatial-index queries
- path building, pressure simulation, smoothing, and SVG output
- input arbitration reducer and every pointer cancellation path
- commands, history transaction boundaries, undo, redo, and memory limits
- fixed render-band derivation and all four stable arrange algorithms, including multiple original selected runs, mixed selections, and boundary no-ops
- anchor generation for every eligible target, including ellipse cardinal points 90, 180, 270, and 360 degrees plus canonical serialization of 360 as 0
- snap radii, hysteresis, deterministic ties, connection validation, resolution, detachment, and minimum line length
- target move, scale, rotation, handle changes, minimum-length rejection, 3D-axis detachment, deletion, Undo, Redo, and clipboard-local ID remapping with connections
- zoom, camera clamping, anchored-scroll equations, and resize calculations
- settings defaults, scope, validation, precedence, and migration
- filename creation, path validation, MIME parsing, and reference decisions
- animation state transitions and reduced-motion duration selection
- workspace activation coordinator tokens, document/session/attachment identity, idempotent current-attachment requests, same-document presentation handoff, latest-pending replacement, dirty detachment, detached-save completion, and headless recovery transitions
- document-worker protocol identity with separate worker epoch, export generation, non-replaceable active save, replaceable prepared successor, verification operation, clipboard operation, and unlock operation; job priority, bounded queue states, stale-result rejection, migration equivalence, clipboard ID plans, and the once-per-session fallback transition; protocol types cannot represent DOM, pointer, scroll, camera, spatial-index, React, or Obsidian API messages
- scroll-owner resolution for scrollable and short notes, `scrollingElement` fallback, reference-counted scrollbar leases, two-frame live-layout transfer, immediate true-unload release, fresh remount acquisition, pen scroll-guard frame coalescing, and complete cleanup after cancellation or lost capture

### Integration Tests

Integration tests cover only important boundaries:

- element store plus renderer plus viewport culling
- renderer instrumentation proving zero React commits or notifications during drawing, panning, zooming, snapping, and culling
- visible-set reconciliation proving DOM mutations are limited to entrants, exits, changed records, and affected order
- delta-domain and applied-node instrumentation proving zero geometry work for paint-only or order-only commits, zero content writes for camera-only or overlay-only frames, and exact changed-attribute counts
- reusable visibility-buffer and stable-slot instrumentation proving zero steady-state collection allocation and correct dense-viewport promotion of a hit element that is not mounted yet
- dense-viewport reconciliation proving the exact expected unique visible-ID sequence and render order by both the frame and elapsed-time deadlines
- background-cache integration proving unchanged aligned indices and theme changes reuse the same compound geometry
- anchor-cache integration proving paint, order, selection, and theme changes hit the cache while target geometry replacement invalidates only that target and its resolved dependents
- canvas input-surface integration covering arbitration precedence plus secondary-button and macOS Control-click pointerdown followed by `contextmenu` with no temporary Eraser, capture, preview, mutation, or history; primary-button tools; touch long press cancellation at the annotation and empty-canvas thresholds; timer, preview, and capture release before menu display; consumed pointerup after menu open; touch selection under every active tool; Context Menu key; `Shift+F10`; focus return; and zero per-content-node listeners
- native menu integration proving action availability, order, icon names, a non-interactive `setIsLabel(true)` Arrange row, disabled Arrange boundaries, owning-document placement, and warning presentation for Delete, Erase all, and Delete embed
- theme integration proving one root scheme update per mounted main or pop-out active presentation and zero path builds, bounds or index work, React ink commits, worker messages, revision changes, dirty transitions, and vault writes; locked-preview tests cover both inherited repaint and the one-reload-per-event compatibility path without I/O
- serializer and preview integration comparing active and standalone document graphics in light and dark schemes and rejecting any noncanonical style, class, URL, or external resource
- renderer topology integration proving one path for each stroke or simple shape when paint permits, compound paths for compatible table and coordinate-system geometry, no unnecessary per-element wrapper, direct ID-to-node references, and ordered `DocumentFragment` insertion for contiguous runs
- zoom and resize adapters proving all layout reads occur before the first DOM write and unchanged observations schedule nothing
- renderer order plus order-only worker updates across both fixed render bands
- connection reverse map plus renderer, bounds, path cache, and spatial-index updates after target transforms
- editor state plus direct live-path and transform previews
- serializer plus worker protocol plus purpose-specific stale-result rejection, proving that clipboard, preflight, and read-back jobs do not invalidate a prepared export generation or its stable save operation
- worker-backed unlock parsing, sequential migration, post-migration validation, bounded transferable point-buffer batches, cancellation before publication, and atomic publication after index construction
- worker dispatch, one-slot coalescing, serialized vault writes, and latest-revision confirmation with deliberately delayed adapters
- successor export dispatched after an older `Vault.process()` begins but before its read-back, followed by a second newer editor revision before successor promotion, proving the older active save still confirms and advances the vault base, a stale prepared result is discarded, the document remains dirty, and only the latest epoch, export generation, and exact editor revision may preflight against that new base without a false external conflict
- repeated order changes proving one dirty flag per band and one complete order materialization at successor dispatch
- mocked Obsidian vault adapter plus atomic save, failure, rename, and external modification
- CodeMirror insertion plus undo file cleanup using mocked host adapters
- clipboard adapter plus worker-backed encoding and decoding, user-activation-preserving delayed `ClipboardItem` data, direct standards-prefixed custom-format construction when `ClipboardItem.supports()` returns false, synchronous construction failure, `text/plain` system fallback, rejected write, complete revision-delta synchronization, validation, ID remapping, stale session or basis-revision rejection, and in-session fallback
- unsaved edit followed by Copy and autosave, proving clipboard synchronization advances the worker model and fragment dirtiness, Copy encodes the edited record, a zero-delta export produces the complete current SVG, and dirty state clears only after its stable save operation is confirmed
- delayed Cut with an intervening edit, selection change, record replacement, detachment, and write rejection, proving each stale case may preserve copied data but removes nothing and creates no Cut history command
- document-worker failure during unlock, migration, clipboard encoding, paste decoding, export, preflight, and read-back, proving one worker-epoch invalidation, old-epoch prepared-successor rejection, new purpose-specific identity, no partial result adoption, equivalent bounded fallback output, no retry loop, and no live-gesture slice; a separate failure after `Vault.process()` begins and before read-back classification must retain the immutable old save proof, verify it under a new `verificationOperationId`, update the confirmed base without rewriting, and preserve a newer dirty revision
- native-scroll integration with a test scroller proving write-only acquisition followed by post-style measurement before input, one shared lease, retention across lock and unlock, `scrollbar-gutter: stable`, persistent desktop `overflow-y: scroll`, stable `clientWidth`, no nested vertical scroller, no right-gutter overlap, zero pointer-time style mutation, two-frame live-layout owner transfer, immediate true-unload release, fresh remount acquisition, and complete cleanup across Reading view, Live Preview, and pop-out ownership
- embed-width integration in ordinary, padded, readable-line, list, callout, max-width, and nested layouts, proving `containerWidth` uses the background container rather than pane width, overrun clamps before input, and toolbar plus input surface remain inside the owner client edge
- settings UI definitions plus persistence adapters
- Reading-view `MarkdownRenderChild` and Live Preview `WidgetType` lifecycle cleanup through host test adapters
- main-window and pop-out widgets sharing one coordinator, with simultaneous activation proving exactly one active session and one latest pending request
- multiple tabs referencing the same SVG, proving one reused document session, one attached presentation, and no duplicate store or worker
- pending widget detachment before activation, proving cancellation without mounting and no retained DOM, `Window`, widget, or attachment generation
- dirty widget detachment during delayed export and vault I/O, proving immediate UI cleanup, continued headless save, latest-revision confirmation, and no detached DOM mutation
- same-session remount during a detached save, proving reuse of the existing store and worker, replacement of an older pending target, and clean reattachment after confirmation
- detached save failure, external conflict, same-embed recovery reattachment, workspace recovery modal routing, and release after Retry, Reload, or Save local copy
- independent coordinator instances proving that cross-process-style concurrency reaches vault conflict handling rather than shared in-memory state
- Vault, FileManager, MetadataCache, Editor, and device-storage adapters for documented operations and failure fallbacks

Integration tests do not launch a complete Obsidian application.

### Performance Tests

Automated performance tests use deterministic fixtures and cover:

- snapshot validation and parsing
- store construction and spatial-index insertion
- viewport query and hit testing
- spatial-query candidate counts, reused scratch-buffer allocations, and repeated page-extent updates after deleting the lowest element
- dense snap candidate lookup and a 512-dependent target transform
- all four arrange operations on an alternating 5,000-element selection in a 10,000-element band and order-only worker export
- oversized-element overflow indexing and queries
- bounded rendering and uniform transformation of a 10,000-element selection
- one-stroke commit and incremental export
- maximum clipboard encode and paste decode, including complete delta synchronization, zero-delta export after Copy, purpose-specific operation identity, main-thread adoption slices, stale-result recomputation, and delayed Cut cancellation
- worker failure fallback for validation, migration, clipboard, export, hashing, preflight, and read-back under continuous synthetic input
- 4,096-point live-stroke latency, a maximum 16-sample mutable tail, and finalized-prefix reuse
- full SVG serialization
- exact standard- and stress-fixture metadata, static-markup, total-byte, and bytes-per-point measurements
- peak main-plus-worker memory during full export, result handoff, vault writing, conflict recovery, and repeated coalesced saves
- steady-state one-stroke allocation, unchanged-record identity, and path-cache hit counters
- steady-state viewport candidate reuse, applied SVG attribute-write counts, dense reconciliation, background-cache reuse, and bounded anchor-cache hit and eviction counters
- history memory bounds

Runtime frame, animation, mobile input, and host-scroll budgets are verified manually in Obsidian using the reference profiles because a simulated DOM does not provide trustworthy rendering timings.

## Coverage and CI Gates

CI MUST run:

- formatting verification
- linting with project size and complexity limits
- TypeScript type checking
- Unit and Integration tests
- at least 85 percent line coverage across executable source
- `jscpd` with `minTokens: 50`
- `knip`
- dependency security audit
- production build and release-artifact verification
- deterministic schema fixture and performance benchmark suites
- a renderer-scoped lint restriction that rejects `querySelector`, `querySelectorAll`, and descendant selector walks in scene reconciliation

No gate may be bypassed through broad exclusions, empty assertions, raised limits, or disabled rules.

## Manual Release Checks

Manual checks are not smoke or end-to-end test suites. They are focused acceptance measurements for behavior that cannot be represented faithfully in the automated harness:

- pen latency and palm rejection on one supported stylus device
- touch arbitration and pinch on iOS and Android
- mouse, trackpad, keyboard, and focus behavior on desktop
- delayed Copy, Cut, and Paste on supported desktop, iOS, and Android WebViews, covering a successful custom format where supported, `ClipboardItem.supports() === false`, synchronous custom construction failure, `text/plain`, rejected system write, in-session fallback, and no Cut removal after an intervening edit, selection change, or detachment
- right-hand native Obsidian scrollbar behavior before, during, and after pen drawing in Reading view, Live Preview, and a pop-out: persistent desktop track where the operating system exposes one, unchanged gutter and `clientWidth` everywhere, no overlay by Inkbook UI, and recorded OS-controlled auto-hide behavior on native overlay-scrollbar systems
- mouse, touch, and keyboard canvas context menus with the specified icons, disabled Arrange boundaries, and red text plus icon for destructive entries
- active-scene, Reading-view, Live Preview, and saved-SVG graphic parity in light and dark schemes, including a pop-out window and one external vector editor; software without media-query support must show the deterministic light fallback
- host-theme chrome, high contrast, and reduced motion
- 10,000-stroke frame, memory, unlock, animation, and export budgets
- lock/unlock and automatic-height animation without flicker or scroll jumps
- Reading view, Live Preview, Source mode, pop-out windows, settings search, enable, disable, and reload without leaked listeners, workers, scrollbar leases, host-element references, portals, or React roots
- rapid activation across tabs and pop-outs, closing a dirty tab or pop-out before autosave, detached save success and failure recovery, and two independent Obsidian instances editing the same file

Each release records pass/fail evidence and any accepted limitation.

## Release Gate

A release is acceptable only when:

- all Blocker and Required behavior in the specification is implemented
- Unit and Integration checks pass
- coverage and quality gates pass
- the 10,000-stroke budgets pass on both reference profiles
- no known critical or high security issue remains
- no known data-loss path remains
- documented manual accessibility and motion checks pass
- the public Obsidian API and Community directory requirements in [Obsidian Integration](obsidian-integration.md) pass against source and release artifacts

## Related Documentation

- [Implementation specification](specification.md)
- [File format](file-format.md)
- [Rendering and performance](rendering-and-performance.md)
- [Embed UI](embed-ui.md)
- [Zoom](zoom.md)
- [Settings](settings.md)
- [Obsidian integration](obsidian-integration.md)
