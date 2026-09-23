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

The device timing protocol and latency targets below are release acceptance requirements outside CI. Automated tests no longer measure elapsed time, CPU time, or latency percentiles; they verify work/resources and simulated scheduling under [Performance CI](performance-ci.md).

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

Frame data is collected with `requestAnimationFrame` timestamps and Long Animation Frame data when available. Input latency uses event timestamps and a mark immediately after the live DOM mutation. Each run reports p50, p95, maximum, missed-vsync rate, and longest consecutive missed-vsync sequence. It reports p99 only for sets containing at least 100 measured samples. The release result is the worst measured run, not a percentile pooled across runs.

Memory is additional heap compared with the same Obsidian pane and locked preview. Record retained and peak live heap from unlock start through worker parsing, migration, buffer transfer, fixture indexing, one full scenario cycle, maximum clipboard Copy and Paste codecs, full export, result handoff, `Vault.process()`, conflict recovery, five rapidly coalesced incremental saves, and five idle seconds. The ceiling applies throughout, including parsed input, editor and worker geometry, clipboard representations, indexes, fragments, prepared output, current vault input, and animation tombstones. Use an explicit development-tools garbage collection only when supported and record that fact; otherwise take three stable heap readings one second apart and use the maximum. The test fails if the ceiling or an unexplained upward trend across five repeated cycles is observed.

The CI memory resource gate runs the standard fixture in an isolated Node.js process with explicit garbage collection. It records `process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers` relative to a post-module-load baseline at production worker export, transferred-UTF-8 handoff, main-thread adoption, serialized vault input, conflict-recovery retention, and release checkpoints. Five complete lifecycle runs each include five commits coalesced into one latest-revision incremental save. These runtime-dependent heap readings cover the combined in-process model and transfer topology; release reports still record the corresponding production Obsidian measurements on both reference profiles.

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
| Command commit excluding export, p95                                               |                                         at most 12 ms |                                       at most 16.7 ms |
| 10,000-element uniform transform commit, p95                                       | at most 100 ms, chunked after immediate visual commit | at most 200 ms, chunked after immediate visual commit |
| Worker SVG export after a full snapshot, p95                                       |                                        at most 750 ms |                                      at most 1,500 ms |
| Incremental worker export after one stroke, p95                                    |                                        at most 100 ms |                                        at most 200 ms |
| Main-thread work caused by autosave in one frame                                   |                                          at most 8 ms |                                         at most 12 ms |
| Debounce expiry to latest revision save confirmation with production adapters, p95 |                                      at most 2,000 ms |                                      at most 4,000 ms |
| Additional plugin memory while active                                              |                                         at most 1 GiB |                                       at most 300 MiB |
| Mounted content paths in a normal viewport                                         |                                         at most 1,200 |                                           at most 900 |
| Mounted SVG nodes in a normal viewport                                             |                                         at most 2,000 |                                         at most 1,500 |
| Compact snapshot metadata for the standard fixture                                 |                                        at most 32 MiB |                                        at most 32 MiB |
| Complete SVG for the standard fixture                                              |                                        at most 48 MiB |                                        at most 48 MiB |

Additional rules:

- Simulated scheduling contracts cover 60, 90, 120, 144, and 240 Hz with frame intervals of approximately 16.67, 11.11, 8.33, 6.94, and 4.17 milliseconds. Production interruptible deadlines reserve 55 percent of each interval. Tests control frame timestamps and checkpoint/input availability; they verify coalescing, progress, bounded work, cancellation, and complete atomic adoption. They do not establish p99, slice elapsed time, or execution-speed budgets. Physical reference-device measurements retain the latency requirements above.
- No input-related main-thread task may exceed 16.7 ms. A prepared transaction adopts as one indivisible task with the same 16.7-millisecond hard limit. Chunked preparation may span multiple tasks, but each slice follows the selected soft deadline and the already rendered preview remains visually stable.
- No pointer sample supplied by `getCoalescedEvents()` may be silently dropped. Nearby samples may be deterministically merged by the documented path builder.
- Unlock, pan, zoom, and drawing must not mount all 10,000 strokes.
- Background generation, bounds updates, spatial-index updates, and cache invalidation must be incremental.
- Camera-only, overlay-only, and theme-only frames perform zero committed-content attribute writes. Paint-only and order-only commits perform zero path construction, bounds calculation, anchor generation, or spatial-index mutation.
- Snap lookup uses the spatial index, and target transforms use the reverse connection map. Neither may scan the complete element store.
- A synchronous document-worker fallback may exceed the corresponding worker duration, but it MUST yield immediately after the bounded unit that crosses the selected soft deadline and MUST pause while a live gesture is active.
- Autosave timers do not count as permission to perform work during an active gesture.
- Unlock worker instrumentation reports input parsing and validation, runtime-buffer copy, bounded batch transfer plus Store adoption, parser finalization, worker-model adoption, and total elapsed time separately. Export worker instrumentation reports model update plus delta validation, SVG serialization, and total worker time separately. Physical-device save measurements cover representative message handoff, receiver adoption, conflict-check, host-I/O, and confirmation costs where those adapters participate. Main-thread preparation follows the interruptible soft-deadline contract, and indivisible adoption follows the 16.7-millisecond hard limit.
- A standard-fixture size report records total bytes, metadata bytes, static-markup bytes, and bytes per stroke point. Pretty-printed output fails regardless of the total.

## Performance Architecture Rules

- Locked embeds use the static SVG preview and mount no editor store or React tree.
- The runtime store is one aggregate containing the private ID map, two ordered ID bands, derived ranks, capacity counters, spatial index, reverse connection map, and commit-time versions. Synchronous commands preflight all affected capacity, connection, and index changes before publishing one atomic delta. Time-sliced mutations prepare all affected members against one source mutation version and adopt them as one transaction. A cancelled, failed, or stale preparation changes none of the aggregate; ordinary commands retain unchanged record identities and do not clone a persisted snapshot.
- Viewport queries, hit testing, erasing, and page extent queries use the spatial index.
- React owns application chrome and coarse editor state only. Individual ink elements are owned by the imperative SVG scene renderer.
- Pointer-move, pan, zoom, pinch, scroll, snapping, culling, and preview frames produce zero React renders, React state updates, and React-visible store notifications. Discrete selection and tool changes may enqueue one coarse UI update after imperative feedback. Cursor-only updates retain fixed SVG-node identity, share at most one pending scene frame, bound actual layout reads independently of pointer-event count, allow at most one synchronous transform write per changed pointer position without rebuilding nodes, and perform no content query or geometry build. Deterministic coverage uses the 10,000-stroke fixture and all five scheduling profiles.
- Chrome callbacks remain referentially stable for one active presentation. A semantic chrome snapshot suppresses `root.render()` when toolbar, active-menu identity, dynamic shape and style icons, layout, and callback state are unchanged.
- Pointer-move processing never clones the complete element array or snapshot.
- The live-stroke builder appends finalized chunks and rebuilds at most 16 retained samples plus their boundary segment; the 4,096th point does not reconstruct the first segment.
- Live-stroke distance, timing, and pressure decisions read the numeric sample buffer directly without reconstructing temporary sample objects for retained points.
- Selection transforms preview with one parent SVG transform when possible and commit geometry once. Raw handle-pointer bursts retain only the latest sample and modifiers, perform at most one complete preview update per animation frame, and synchronously flush that sample before pointer-up commit. A pen handle release with zero pressure and no contact button commits the queued contact position instead of introducing a final hover-coordinate update. Cancellation, pointer-capture loss, and disposal cancel the scheduled frame and discard its sample. Exact element previews, transforms, selection paths, and snap paths are staged and written together by the scene frame writer. The imperative selection overlay applies the same transform in that frame and never falls back to stale Store bounds. Handle layout, grab offset, selected geometry, transform input, preview bounds, page-growth extent, and overlay use one gesture-start snapshot and one resolved frame result. A stationary pointer produces no resize delta after target acquisition, perpendicular noise produces no uniform scale delta, and crossing the fixed anchor cannot reverse into growth. A singly selected line or arrow uses its centerline plus start, canonical bend, and end handles with no box or rotation handle. Pointer-type and zoom-dependent invisible handle targets must cover resize, endpoint, bend, coordinate, and rotation handles without changing their visible screen-size geometry. Exact per-element handle previews require at most 256 elements, at most 16,384 aggregate geometry samples, and at most 256 samples in each freehand stroke. The per-stroke threshold is chosen once from gesture-invariant input. Scale feedback selects at most 256 viewport-near retained roots across all element types, using the continuous feedback and snapshot handoff defined in [Rendering and Performance](rendering-and-performance.md). Constant-width freehand strokes transform their canonical centerlines without rebuilding; pressure strokes and non-affine shapes use canonical replacement geometry with continuous snapshot-relative feedback. Regression coverage must assert zero sample materialization in handle-pointer updates, stable retained path-node identity, and complete pressure snapshot publication. Regression coverage checks all element kinds for canonical preview/commit geometry and paint, dense pressure self-overlap, local pressure, alpha compositing, camera changes, fair progress and same-frame visual movement during continuous coalesced input, snapshot-relative transforms, cancellation, and atomic commit handoff. A handle commit may materialize synchronously only at or below 1,000 elements, 16,384 aggregate geometry samples, and the reverse-dependent budget; larger work prepares in input-aware slices and adopts once. Every slice and final token adoption rechecks cancellation and the gesture generation. Dragging selected content uses its transform-only preview and switches to sliced commit preparation above 1,000 elements.
- Each eraser update shares at most 12,288 work units between resumable spatial traversal and exact intersection checks, with a deadline checked every 1,024 units. Traversal charges occupied or empty cell/column visits, iterator transitions, duplicate memberships, rejected bounds, and overflow entries. Candidate batches contain at most 128 IDs; one active query retains deduplication state bounded by the indexed document capacity. The sweep retains at most 512 segments. Owning-window animation frames continue unfinished work while the pointer is stationary. Commit cancels the live continuation frame and drains cancellably before one atomic removal command; queue overflow, document revision changes, or stale index cursors cancel the entire sweep and release pending work. Cancellation never commits a truncated result.
- Selection size never disables culling: visible selected content and a maximum 256-root active transform subset are mounted, while offscreen selection uses aggregate bounds.
- Bounds, paths, and semantic anchors validate the element ID plus its commit-time `geometryVersion`. Paint, order, selection, and theme changes are cache hits. Main-thread path strings are limited to mounted nodes plus the bounded recently-unmounted cache; unlock does not generate all document paths.
- Viewport invalidations coalesce into one pending animation-frame update. Visible-ID diffing mutates only entrants, exits, changed records, and affected order; scene groups are never replaced wholesale.
- Visible-set reconciliation uses stable numeric slots, reusable buffers, and epoch markers or bitsets. An ordinary frame allocates no replacement full candidate, visible, entrant, exit, or deduplication collection.
- Committed paths and decorative overlays use `pointer-events: none`; one presentation-owned focusable input surface handles the canvas. No SVG content node owns an event listener.
- Applied-node state suppresses unchanged SVG attributes. Geometry, paint, order, connection, visibility, camera, overlay, background, and theme dirtiness remain independently observable in renderer instrumentation.
- Each scene frame completes layout reads before DOM writes. Repeated observers and unchanged dimensions schedule no work. Toolbar overflow reads run only after a changed positive width, a dirty layout observation, or a semantic layout-key change.
- Document-worker state synchronization contains changed and removed IDs, order, and page state after initialization; it atomically advances `modelRevision` and fragment dirtiness, while clipboard encoding uses selection IDs rather than a complete selection clone.
- Order-only changes carry explicit render-band order, and target changes carry every automatically re-resolved line or arrow.
- The newest dispatched export generation orders only replaceable export results and `preparedSuccessor`. Once admitted, `activeSaveOperation` remains valid through mandatory read-back even when a newer export is dispatched. Other worker jobs have independent operation IDs; queued timers have no identity.
- At most one export request, one non-replaceable active save, one prepared successor, and one vault write are in flight. Later commits occupy one coalesced target, vault writes are serialized, and superseded prepared outputs are released.
- Worker state retains one canonical typed geometry buffer per stroke plus bounded current per-element snapshot and static-SVG fragments. Main-thread and worker allocation together remains inside the memory ceiling.
- One document worker runs one bounded non-preemptive queue. It performs unlock validation and migration, clipboard codecs, SVG export, hashing, preflight, and read-back verification, but receives no DOM, pointer, scroll, camera, spatial-index, React, or Obsidian API object.
- Worker failure invalidates the worker epoch and switches once per session to equivalent input-aware main-thread slices under a new epoch; it does not recreate a worker or retry partial results in a loop.
- Every active patterned background uses one presentation-owned SVG pattern tile and one bounded full-page coverage path derived from the same canonical guide layout as standalone export. Geometry is independent of viewport clipping and camera pan. Guides use normal antialiasing, a scale-independent one-screen-pixel stroke, and the same 25-percent-alpha scheme palette in both presentations. Static export estimates guide subpaths and serialized bytes before allocating any background path fragment and rejects an over-budget page without partial output.
- Background coverage is keyed by page and pattern geometry and regenerates only when that key changes. It spans the complete prepared page, so viewport clipping and camera movement never change the key. Theme changes reuse its geometry.
- A culling refresh uses 80 screen pixels of overscan converted to page units at the current zoom. The mounted envelope is reused only while the current viewport plus a 40-screen-pixel safety reserve remains inside it, so no visible element can be omitted and the retained trailing edge never exceeds 120 screen pixels before refresh.
- Dense viewports eventually mount every exact visible element in input-aware batches; they may disable animation and prewarming but may not rasterize, merge, or hide editable content. Each mount slice uses an absolute deadline plus the 4,096-stroke-point and 16,384-geometry-cost budgets, while one oversized entrant remains progress-safe.
- Every cache has an entry or byte limit, releases removed records immediately, and is released on editor unmount.
- Lifecycle soak tests repeatedly mount and unmount React chrome and adaptive menu sessions, switch notes and attachments, create and terminate workers, and run the 10,000-stroke memory lifecycle without retaining roots, menus, listeners, observers, animation frames, workers, or host references.

## Animation Tokens

```ts
const motion = {
  fast: 120,
  surface: 220,
  standard: 180,
  erase: 300,
  layout: 240,
} as const;

const easing = {
  erase: "cubic-bezier(0.3, 0, 0.7, 1)",
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  emphasized: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

const layoutEasing = "ease-out";
```

Durations are milliseconds. The shared `surface` value controls toolbar and feedback presence, adaptive phone sheets, and adaptive content resizing. Inkbook-owned desktop and tablet modal motion and adaptive-panel entrance use the `fast` value. Element and chrome motion shares one default curve. Eraser dissolution uses the symmetric `erase` curve so expanding blur remains visible through the middle of the fade. Container-height transitions use the immediate-start layout curve so their first visible frame does not hesitate before moving.

## Animation Contract

Every user-visible state change animates unless listed as immediate or reduced motion is active.

| Transition                                                          |   Duration | Properties                                                                    |
| ------------------------------------------------------------------- | ---------: | ----------------------------------------------------------------------------- |
| Complete primary toolbar pill enter or exit                         |     220 ms | fixed-position scale between 0 and 1                                          |
| Tool active state                                                   |     120 ms | shared indicator translate, foreground color                                  |
| Native Markdown editor menu open or close                           | host-owned | no Inkbook class, clone, or motion                                            |
| Wide adaptive panel surface open                                    |     120 ms | one-shot opacity and scale from 0.96 to 1, ease-out                           |
| Wide adaptive panel surface close                                   |     120 ms | opacity and scale to 0.96; immediate action handoff and disposal              |
| Phone adaptive panel surface open (except Context), close or settle |     220 ms | sheet translate                                                               |
| Phone Context menu surface open                                     |     120 ms | sheet translate                                                               |
| Phone sheet subpage forward or back                                 |     220 ms | content opacity and small horizontal translation; retained sheet host         |
| Phone sheet subpage height change                                   |     220 ms | measured block size, growing or shrinking without surface re-entry            |
| Background panel content resize                                     |     220 ms | block size without replaying surface presence motion                          |
| Settings tool disclosure open or close                              |     180 ms | measured content block size                                                   |
| Desktop and tablet Inkbook modal open or close                      |     120 ms | native modal surface opacity and scale between 0.96 and 1                     |
| Phone Inkbook dialog open or close                                  |     220 ms | shared adaptive bottom-sheet translate                                        |
| Operational feedback open or close                                  |     220 ms | fixed-surface scale between 0 and 1                                           |
| Selection handles enter or exit                                     |     120 ms | opacity, scale                                                                |
| Eraser and selection Delete pending-removal feedback                |     300 ms | opacity and expanding blur                                                    |
| Committed shape or pasted-element entrance                          |     120 ms | opacity, scale from 0.96 to 1                                                 |
| Cut or other command-removal exit                                   |     120 ms | retained visual tombstone opacity, scale to 0.96                              |
| Background type or spacing change                                   |       0 ms | atomic pattern and coverage replacement                                       |
| Color, opacity, width, fill, or outline-style change                |     120 ms | supported property interpolation or old/new path crossfade                    |
| Initial embed appearance                                            |     180 ms | outer block height; [first-appearance contract](embed-ui.md#first-appearance) |
| Locked to active height                                             |     240 ms | container height with native scroll position preserved                        |
| Active to locked height                                             |     240 ms | container height with native scroll position preserved                        |
| Unlock preview-to-editor representation swap                        |       0 ms | atomic visibility after editor readiness                                      |
| Lock editor-to-preview representation swap                          |       0 ms | atomic visibility after exact preview paint                                   |
| Automatic page growth or shrink                                     |     180 ms | container height with native scroll position preserved                        |
| Conditional toolbar control enter or exit                           |     220 ms | fixed scale, left-to-right entry, right-to-left exit                          |
| Arrange result                                                      |     120 ms | old/new path opacity crossfade where overlap changes visibly                  |
| Snap candidate feedback update                                      |       0 ms | immediate path replacement or removal                                         |

Implementation rules:

- Opacity and transforms are preferred for eligible element and chrome transitions because they avoid layout and paint work. The embed shell and preview/editor representation handoff never animate opacity.
- Initial presentation appearance animates the outer root as specified in [Embed UI](embed-ui.md#first-appearance). Once presented, editor height animation is permitted only for the single background container. During unlock and automatic growth or shrink, prepare one top-anchored scene envelope whose height is the writing-row-aligned ceiling of the currently visible and target page heights. Growth waits for that complete scene commit and one paint opportunity before revealing it. Shrink retains it until clipping reaches the target. Viewport changes update visibility and culling but perform zero background builds because the pattern coverage already spans the complete prepared scene. A rapid reversal retargets from the visible CSS height, never a stale settled endpoint. The exact outer target and smaller final scene become paintable together in one final commit. Background type and spacing changes never enter this transition. The scene keeps block-start zero and a top-left transform origin and is never vertically centered. Outside the editor presentation, the owned adaptive-panel scroll region, Settings Background content, and Settings tool disclosures may animate their measured block size as specified in the transition table.
- Width and zoom changes commit scroll compensation, camera transform, overlay geometry, and container height in the same animation frame. Active-editor height-only transitions leave camera state unchanged, suppress browser anchoring on the exact native scroll owner, and retain the embed root's viewport Y position. Unlock acquires that visual anchor before editor DOM insertion and hidden layout preparation. The hold performs one constant-time root-position read per frame and writes `scrollTop` only after measured host drift. A host scroll event corrects the same drift synchronously before paint. User scroll intent takes ownership immediately.
- One persistent outer shell owned by the presentation root draws the background, border, radius, restrained shadow, and clipping edge throughout locked, unlocking, active, and locking states. The preview and editor are borderless inner layers and never make that shell transparent. Native button shadows are suppressed, so hover never changes the embed depth.
- Unlock keeps the locked preview visible above the mounted editor until layout and the first complete scene commit have been measured and painted once at the final scene height behind the locked clip. In the frame that starts the 240-millisecond block-size transition, the inner layers exchange visibility atomically: the preview and any mounted loading feedback become hidden while the complete active scene, foreground, toolbar, input, and focus state become available. The top-anchored background pattern already covers the complete prepared envelope, and container clipping progressively reveals it without a per-frame background rebuild or realignment. The completion step removes the already hidden old preview and temporary clip geometry. Lock prepares the exact preview below the disabled editor, gives it one complete paint opportunity, then atomically exchanges the inner layers before unmounting the editor. Neither direction contains a frame with both representations hidden or detached.
- Lock disables input immediately and runs the 240-millisecond width-fit and height transition concurrently with saving and the 220-millisecond whole-pill toolbar exit. If saving or the decorative toolbar exit takes longer, the disabled editor waits at locked geometry; persistence itself is never delayed by chrome motion. The exact saved preview is adopted only after validation, layout, the toolbar exit, and a paint opportunity. The representation swap itself has zero duration and never modifies shell opacity.
- Context controls use their 50-millisecond stagger from left to right when selection or clipboard state makes them appear and from right to left when they disappear. Paste is the first context action. Their transient aggregate width never changes the layout stage or the primary pill's exact center; excess actions scroll inside the fixed right corridor until the primary pill plus its minimum corridor itself requires the complete scrollable row. Completed exits retain non-interactive fixed layout slots until the final staggered exit completes, then the complete exit batch is removed atomically without moving an exit that is still visible. Any remaining horizontal relocation after an atomic slot change uses a 120-millisecond FLIP translation and adopts its final position immediately under reduced motion. A complete editor lock instead starts every still-visible context-control exit with the whole-pill exit so their shared 220-millisecond duration cannot delay the concurrent 240-millisecond lock layout transition or be truncated when the presentation detaches.
- Inkbook Overflow, Shape, selection, Canvas context, Style, and Background menus share the lifecycle-owned adaptive surface and preserve host appearance and interaction. The native Markdown editor insertion menu remains unmodified. Owned styling never traverses host DOM or changes global safe-area tokens. Wide surfaces use a one-shot fast opacity and scale entrance and matching exit. Interrupted entrance closes from its current rendered position; action activation, handoff, and owner disposal bypass exit motion. Phone menus use the shared sheet behavior; Context has a fast entrance while other sheets use the surface entrance. Every phone exit and aborted-swipe return retains the surface duration. Background content resizing animates only block size and never replays presence. Reduced motion completes owned panel states immediately. Layout, input, focus, and teardown follow [Obsidian Integration](obsidian-integration.md#commands-menus-icons-and-styling).
- Inkbook action, settings, keyboard-shortcut, and recovery dialogs retain native Obsidian `Modal` elements, focus handling, and dismissal on desktop and tablet. Desktop and tablet use a 120-millisecond scale from 0.96 to 1 and its reverse on the public modal surface. Opacity fades from 0 to 1 on entry and reverses on exit; both directions use `ease-out`. Phone reuses the shared 220-millisecond adaptive bottom sheet and its [lifecycle and layout](obsidian-integration.md#commands-menus-icons-and-styling). Initial content is prepared before mounting, and content-height transitions do not run during entrance. Reduced motion skips the owned transition, and disposal cancels pending motion.
- Operational feedback uses the same 220-millisecond scale entrance and reverse exit. An exiting message becomes inert and inaccessible immediately, retains only its visual surface until the motion completes, and is removed immediately during replacement, presentation disposal, or plugin unload.
- Ordinary automatic page growth starts after a committed geometry change. A selection move may additionally request a larger writing-row-aligned preview extent derived from its current maximum bottom. Preview targets are monotone and coalesced through the same 180-millisecond height transition without passive scroll stabilization while pointer or autoscroll input owns scrolling. Cancellation returns to the captured original height. Commit retains the greater of the Store maximum bottom and the final rendered preview bottom, preventing a stale or adjacent-frame Store extent from clipping moved geometry.
- A new input gesture immediately completes or cancels any automatic height or tool animation that would delay handling, closes an open adaptive menu, applies the correct final layout, releases or rebases transition scroll stabilization, and then handles the gesture in the same frame.
- Live ink paths, eraser sweeps, and selection transform previews update immediately and are never tweened behind the pointer.
- Connected endpoints update with their target in the same live frame and are never tweened behind it.
- Committing a live stroke or gesture transform is immediate because the committed path exactly replaces an already visible preview. It MUST NOT flash, fade, or move during handoff.
- Undo uses the inverse transition of its command; Redo uses the forward transition. Reinserted or removed geometry uses the 120-millisecond entrance or exit. Move, scale, rotate, bend, and axis edits interpolate their preview transform from current to restored geometry over 120 milliseconds, then materialize the exact target.
- Model removal is atomic. An exit animation uses a non-interactive visual tombstone that is excluded from hit testing, bounds, history, export, and accessibility state.
- Any discrete user-visible UI or canvas change not named in the table uses the 120-millisecond opacity fallback. Immediate behavior is permitted only for live input, exact preview-to-commit handoff, focus and accessibility state, reduced motion, or a recovery action whose delay could risk data.

## Reduced Motion

When reduced motion is active:

- all non-essential durations become 0 ms
- height, camera, and preview state changes apply in one frame while retaining the native scroll position
- focus movement, feedback, visibility, and final geometry remain unchanged
- no information may depend on animation alone

## UX Acceptance

- Unlock and lock show no empty, unmeasured, stale, or half-rendered frame.
- Unlock and lock begin without an artificial delay. Unlock schedules no pending status before 500 milliseconds, while lock mounts none before 150 milliseconds. If unlock remains unresolved at its boundary, it schedules one non-layout, non-interactive icon status for the next animation frame; that callback rechecks operation identity and pending state immediately before mounting, so an activation completed in the boundary interval produces no painted status flash. The status may be present even when unlock target height is still unknown. Scene readiness removes it atomically with hiding the locked preview and exposing the active editor. A known failure shows or replaces pending feedback with the matching recovery UI immediately, before the browser can paint both states. Reduced motion keeps a mounted status and removes only its rotation.
- Unlock and lock retain exactly one continuously painted shell border, background, and radius while exchanging only borderless inner representations. No frame may expose the host background or a retained locked-height SVG edge. Automatic page growth reveals a fully committed larger scene and keeps bounded guide coverage ahead of every newly visible writable region, while shrink clips the previous larger scene until its outer transition completes; neither direction jumps after the container moves.
- First unlock shows the same centered measured toolbar geometry as the next resize; no resize is required to correct its stage or width.
- During a continuous window resize after initialization, every positive observed content width is applied in the next coalesced frame. The SVG, proportional zoom, page height, and scroll anchor track the live width without waiting for two equal resize frames or jumping when resizing stops.
- Lock, unlock, automatic growth, and automatic shrink preserve the embed root's viewport Y position unless the user deliberately scrolls, including when the note starts at its bottom boundary. A bottom-boundary lock preallocates its complete final range deficit before the first shrink frame. If the smaller locked layout cannot naturally retain the original position, the passive reserve survives editor disposal without continued anchor suppression, releases on deliberate scrolling, or transfers into the next unlock until natural growth makes it removable without movement. Unlock protection begins before editor DOM insertion rather than at the later visible transition. Browser anchoring is suppressed only for preparation, the transition, and two settlement frames; height-only animation frames perform no camera rewrite and no scroll write without measured drift, and CodeMirror receives at most one deferred host measurement after settlement.
- Pending and dominant vertical one-finger touch events remain available to Obsidian and the browser, including native kinetic scrolling. Touch-down alone never selects or deselects an annotation. Short stationary tap, claimed finger drawing, pan or scroll, long press, movement of an already selected annotation, and every selection handle have separate deterministic outcomes; pan, scroll, pinch, and long press produce no selection effect. A preselected-overlay move or handle transform claims the gesture at pointer start and prevents every still-cancelable `touchstart` and `touchmove` from initiating native scrolling. A later non-cancelable host event is propagation-isolated but never receives a futile `preventDefault()` call. Horizontal one-finger movement pans with the specified response when zoom permits and remains clamped at width fit; once claimed, it cannot open a host pane or side-panel gesture. Selection edge scrolling reprojects the held viewport point after every applied native scroll or camera frame before rendering the next move preview, so selected content remains under a stationary finger. The non-animated preview reserve may grow before that frame without competing scroll correction. Two-finger movement remains an Inkbook pinch. Purely horizontal direct and kinetic frames do not write the native scroll owner's `scrollTop`. Terminal events remain available for host cleanup, and a missed terminal, pointer reuse, window blur, or hidden owning document cannot leave capture or a navigation gesture active.
- Growing an owning window invalidates the outer width clamp even when the currently clamped Inkbook root has not changed size yet. The mounted toolbar is observed directly, and its Wide or Scrollable stage and measured primary-pill edge are correct after both growth and shrink. Stage selection uses the intrinsic primary control-track width rather than the current scrollport width, so shrinking to Scrollable and growing back cannot retain a stale stage.
- A modifier-key pixel-wheel sequence whose two axis magnitudes remain below 16 pixels changes zoom in its first animation frame, remains proportional at 2.5 times the raw fractional step, preserves its pointer anchor, and prevents the host zoom only while Inkbook owns that gesture. Larger pixel events plus line- and page-mode mouse-wheel events apply one signed 1.08 step per event. Keyboard steps retain the 1.08 factor, while touchscreen pinch remains the direct finger-distance ratio.
- Controls never change hit-target size between normal, hover, active, and focus states.
- Conditional toolbar controls do not overlap or cause repeated layout-stage oscillation.
- The mounted Style control updates its existing Palette SVG when the active tool or its defaults change: stroke and highlighter colors affect only the solid glyph, line and shape outlines reproduce `solid`, `dashed`, or `dotted`, closed-shape fill uses the configured color and opacity, canonical wells remain solid, and Select or Eraser uses the neutral host icon color.
- Conditional Copy, Cut, Paste, and Delete controls appear as separate 48-pixel circular surfaces to the right of the primary pill without changing its measured center in Wide. If the primary pill plus every visible context action does not fit, one transparent rounded horizontal scrollport owns the complete row and preserves every 48-pixel outline with vertical breathing room. The outer non-scrolling composition paints the toolbar shadow beyond the clipped viewport, and the scrollport applies no edge fade or alpha mask. Every action remains pointer- and keyboard-reachable without shrinking controls, a rectangular background strip, a clipped shadow, or a second hidden action viewport. The owner-window resize observer refreshes the row overflow and pill edge even when the responsive stage does not change.
- The primary tool group owns exactly one non-interactive active-tool indicator. It remains mounted while its transform slides between the exact 36-pixel inset circles of the old and new tool over 120 milliseconds, retargets from its currently rendered transform during rapid changes, and moves immediately under reduced motion. Tool buttons and icons remain mounted throughout.
- Every destructive action has confirmation where documented and preserves undo when possible.
- Every failed operation leaves an accurate outcome and a clear next action such as Retry, Reload, Save copy, or Continue editing. Expected unavailability that does not begin an operation may remain silent.
- Selection handles, crosshairs, tool icons, eraser radius, and toolbar controls remain screen-sized across zoom levels. [Tool Cursors](editor-tools.md#tool-cursors) use the native system crosshair, exact toolbar icon variants, and configured outline/fill colors and opacities; the offset icon remains visible throughout drawing without a filled cursor disk.
- Animation starts from the currently rendered state when interrupted and never jumps back to an earlier state.

## Accessibility Acceptance

The editor targets WCAG 2.2 AA within the capabilities of the Obsidian host.

- Every icon-only control has an accessible name and tooltip.
- The canvas input surface is keyboard-focusable, has an accessible name, and shows a visible `focus-visible` indicator without changing document geometry.
- The toolbar exposes one `toolbar` role, one labelled primary control group, and a second labelled editing-action group only while context actions are present.
- Tool buttons expose pressed or selected state. Action-menu triggers expose expanded state and `aria-haspopup="menu"`; the Style trigger for the owned adaptive panel exposes `aria-haspopup="dialog"`.
- Opening an adaptive panel places initial focus on its first control, never on the dialog container.
- Tab enters and leaves each visible toolbar group. Arrow keys move within the primary track or context-action strip. Home and End move to the first and last visible controls in that group. If the last context action disappears while focused, focus moves to the primary overflow trigger.
- Escape closes the current adaptive menu, cancels an uncommitted gesture, or clears selection in that order.
- Focus returns without scrolling to the trigger when an adaptive menu closes and moves to the nearest surviving control when a conditional button disappears.
- Keyboard commands exist for every toolbar action that is not inherently pointer-geometric.
- Arrange actions have configurable canvas-local keyboard bindings and are not duplicated through Obsidian command registration.
- `Shift+F10` opens the owned canvas menu, whose close operation returns focus to the canvas surface or invoking control.
- Focus indicators, icons, text, active states, selection outlines, and gradients meet applicable contrast requirements in light and dark themes.
- Touch targets are at least 44 by 44 CSS pixels even when the visual icon is smaller.
- Inkbook feedback and confirmations are announced through accessible UI in the owning document.
- Canvas element manipulation remains primarily graphical in version 1, but Delete, Cut, Copy, Paste, Undo, Redo, and style changes are keyboard-operable for the current selection.

## Automated Test Strategy

The project uses Unit and Integration tests only. End-to-end tests and smoke tests are explicitly out of scope. For every new or changed test, including performance tests, inspect existing coverage, fixtures, and helpers first and extend or reuse them where suitable. Minimize CI work by preparing identical immutable inputs once per suite where safe and combining related checks when this avoids duplicate expensive execution without obscuring failures or weakening scenario independence. Parameterization alone does not reduce work if each case repeats the same setup. Create fresh mutable state for each case; never share mutable parser/session instances, depend on test order, or reuse another test's result. Preserve full capacity inputs, boundary and failure cases, meaningful transitions, assertions, isolation, and coverage thresholds. Review redundant setup and execution costs as part of every test change; do not introduce generic test infrastructure solely to remove trivial duplication.

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
- anchor generation for every eligible target, including ellipse cardinal points 90, 180, 270, and 360 degrees plus canonical serialization of 360 as 0, and line or arrow start and end anchors
- snap radii, hysteresis, deterministic ties, absolute 90-degree line and arrow snapping, absolute 45-degree coordinate-axis snapping, semantic-anchor precedence, connection validation, cycle rejection, transitive resolution, detachment, and zero-length lines
- target move, scale, rotation, handle changes, coincident endpoint propagation, 3D-axis detachment, deletion, Undo, Redo, and clipboard-local ID remapping with connections
- selection Style summaries for coordinate-system dimensionality and table column count, including homogeneous, mixed-value, mixed-kind, absolute multi-selection edits, and no-op states
- Select session and vault defaults for Rectangle, Lasso, Fully enclosed, and Touched, including version 3 migration, Style and Settings parity, selected-state accessibility, reset behavior, and availability beside element Style controls while Select is active
- rectangle and bounded freeform-lasso candidate matching for Touched and Fully enclosed across strokes, straight and curved linear elements, arrow nodes, filled and unfilled closed shapes, tables, coordinate systems, rotation, additive selection, cancellation, invalid input, and identity-preserving no-op results
- active-tool Style-icon derivation and in-place toolbar updates for neutral, stroke, outline-only, no-fill shape, and filled-shape states across every supported outline style and Theme text color
- coordinate-system dimensionality and axis-handle commands plus table column-count and separator-handle commands, including retained and removed-axis connections, absolute 45-degree axis snapping, canonical persisted column width, local-right addition and removal, fractional widths such as a 121-unit three-column creation, header default-position snapping, equal-column snapping, zero-sized tables and coincident separators, optional `columnOffsets` round trips and backward-compatible omission, repeated count changes without column-width drift, the maximum per-edit rendered left-edge displacement across the complete rotation range with a 0.003-page-unit bound, per-table multi-selection geometry, bounds rejection, atomic dependent-anchor updates, Undo, and Redo
- straight-highlighter open centerline selection with start, bend, and end handles, no rectangular fill or rotation handle, bend canonicalization, and endpoint edits
- canonical box-resize pivots derived from rounded bounds for fractional and rotated box shapes and tables, plus stable transformed freehand pivots without preview flicker, no-op commits, or position jumps
- zoom, camera clamping, anchored-scroll equations, and resize calculations
- settings defaults, scope, validation, precedence, and unsupported-version rejection without legacy migration
- refresh-rate settings and UI values for Auto, 60, 90, 120, 144, and 240 Hz; visible detecting and detected Auto status; the 120-Hz pending and invalid-measurement fallback; one-shot per-window Auto classification under jitter and dropped frames; hidden-window deferral; independent pop-out measurements; fixed-mode bypass; disposal; and live profile changes
- one developer-console warning per owning window when the bounded main-thread worker fallback is first activated, with no document content or identifier disclosure and no repeated per-document warning noise
- filename creation, path validation, MIME parsing, and reference decisions
- animation state transitions and reduced-motion duration selection
- workspace activation coordinator tokens, document/session/attachment identity, idempotent current-attachment requests, same-document presentation handoff, latest-pending replacement, dirty detachment, detached-save completion, and headless recovery transitions
- document-worker protocol identity with separate worker epoch, export generation, non-replaceable active save, replaceable prepared successor, verification operation, clipboard operation, and unlock operation; job priority, bounded queue states, stale-result rejection, migration equivalence, clipboard ID plans, and the once-per-session fallback transition; protocol types cannot represent DOM, pointer, scroll, camera, spatial-index, React, or Obsidian API messages
- revision-bound validation derivations, exact element and batch alignment, Store-to-worker bounds reuse, stale-derivation eviction during coalescing, safe fallback calculation when a derivation is absent, targeted page and connection validation, and atomic rejection without model advancement
- scroll-owner resolution for scrollable and short notes, `scrollingElement` fallback, reference-counted scrollbar leases, two-frame live-layout transfer, immediate true-unload release, fresh remount acquisition, pen scroll-guard frame coalescing, and complete cleanup after cancellation or lost capture

### Integration Tests

Integration tests cover only important boundaries:

- element store plus renderer plus viewport culling
- renderer instrumentation proving zero React commits or notifications during drawing, panning, zooming, snapping, and culling
- visible-set reconciliation proving DOM mutations are limited to entrants, exits, changed records, and affected order
- delta-domain and applied-node instrumentation proving zero geometry work for paint-only or order-only commits, zero content writes for camera-only or overlay-only frames, and exact changed-attribute counts
- reusable visibility-buffer and stable-slot instrumentation proving zero steady-state collection allocation and correct dense-viewport promotion of a hit element that is not mounted yet
- semantic chrome snapshots proving unchanged state skips React root renders, callback identities remain stable, and toolbar measurement is skipped when layout-relevant state and width are unchanged
- dense-viewport reconciliation proving the exact expected unique visible-ID sequence, render order, persistent cursor, one unchanged-viewport query, and bounded point and geometry cost by both the frame and elapsed-time deadlines
- already-expired 144-Hz and 240-Hz deadlines proving that every renderer and time-sliced store consumer processes at least one bounded unit before yielding, including a maximum-complexity path
- background-cache integration proving page and pattern geometry changes rebuild complete coverage while viewport and camera changes, plus theme changes, reuse the same coverage geometry
- anchor-cache integration proving paint, order, selection, and theme changes hit the cache while target geometry replacement invalidates only that target and its resolved dependents
- canvas input-surface integration covering arbitration precedence plus secondary-button, combined-button, non-primary-pointer, macOS Control-click, pen-barrel, and eraser-tip handling before selection handles; atomic rejection of invalid or oversized coalesced batches; `contextmenu` with no unintended capture, preview, mutation, or history; primary-button tools; tool-independent outside deselection for eligible mouse, pen, and claimed finger drawing; touch tap duration and movement thresholds; zero selection changes from pan, scroll, pinch, or long press; movement only for a preselected annotation; long-press cancellation at the annotation and empty-canvas thresholds; timer, preview, and capture release before menu display; consumed pointerup after menu open; `Shift+F10`; focus return; and zero per-content-node listeners
- owned menu integration proving action availability, order, icon names, disabled Arrange boundaries, owning-document placement, red warning presentation for Delete and Delete embed, the registered `inkbook-eraser-caution` icon and matching orange Erase all title, native appearance and keyboard parity, owned safe-area padding without global token mutation, one-shot entrance and complete dismissal cleanup
- dialog opening and closing profiling records frame intervals and surface geometry on desktop, tablet, and phone, including settings, shortcuts, actions, and recovery; entrance keeps prepared content geometry stable without concurrent content-height motion
- adaptive-panel integration proving one active surface, owning-document and pop-out placement, wide trigger anchoring and viewport clamping, outside and Escape dismissal, focus trapping and restoration, Overflow-to-Background and Background-to-Overflow handoff, in-place pattern and spacing changes, phone safe-area and 60-percent visual-viewport limits, internal scrolling, keyboard displacement, one-shot entrance, whole-surface downward swipe with direct tracking, abort recovery without entrance replay, direction and scroll arbitration, trailing-click suppression, handle fallback, native host-history Back handling independently of Escape, repeated Back during exit, nested-sheet ordering, reduced motion, and complete lifecycle cleanup
- theme integration proving one root scheme update per mounted main or pop-out active presentation and zero path builds, bounds or index work, React ink commits, worker messages, revision changes, dirty transitions, and vault writes; locked-preview tests cover both inherited repaint and the one-reload-per-event compatibility path without I/O
- serializer and preview integration comparing active and standalone document graphics in light and dark schemes and rejecting any noncanonical style, class, URL, or external resource
- locked-preview integration proving that only completely safe-envelope-validated presentation markup mounts, metadata and embedded styles are absent from the mounted tree, native image handlers cannot attach, and guide weight and intensity match the active scene at DPR 1 and 2 across representative fractional width-fit scales
- renderer topology integration proving one path for constant-width strokes or simple shapes when paint permits, at most 16 pressure paths with their required opacity wrapper, compound paths for compatible table and coordinate-system geometry, no unnecessary per-element wrapper, direct ID-to-node references, and ordered `DocumentFragment` insertion for contiguous runs
- zoom and resize adapters proving all layout reads occur before the first DOM write and unchanged observations schedule nothing
- renderer order plus order-only worker updates across both fixed render bands
- connection reverse map plus renderer, bounds, path cache, and spatial-index updates after target transforms, including line-to-line and arrow-to-arrow endpoints, cycle rejection, and transitive dependent propagation
- selection overlay and handle integration for straight highlighters, line and arrow angular guides, transient endpoint straightening with commit-only bend removal, coordinate-axis and coordinate-origin angular guides, accent edit lines for coordinate axes and table separators, constant-screen rotation-handle spacing, and stable box-resize previews while content and overlays remain synchronized
- selected coordinate-system and table structural Style edits proving one coarse UI update, geometry deltas only for changed targets and resolved dependents, no full-store scan or clone, exact compound-path replacement, and complete active-versus-standalone SVG parity
- editor state plus direct live-path and transform previews
- serializer plus worker protocol plus purpose-specific stale-result rejection, proving that clipboard, preflight, and read-back jobs do not invalidate a prepared export generation or its stable save operation
- worker-backed unlock parsing, pre-materialization JSON container-width checks, bounded escape-string scratch, sequential migration, post-migration validation, bounded transferable point-buffer batches, exact worker-versus-batch-versus-final-Store integrity manifests, cancellation before publication, and atomic publication after index construction
- worker dispatch, one-slot coalescing, serialized vault writes, latest-revision confirmation with deliberately delayed adapters, Store-to-worker export-manifest mismatch coverage proving one full-snapshot rebuild followed by either a verified save or fail-closed recovery without a Vault write, and rejection of SVG bytes whose envelope digest disagrees with the verified manifest
- successor export dispatched after an older `Vault.process()` begins but before its read-back, followed by a second newer editor revision before successor promotion, proving the older active save still confirms and advances the vault base, a stale prepared result is discarded, the document remains dirty, and only the latest epoch, export generation, and exact editor revision may preflight against that new base without a false external conflict
- repeated order changes proving one dirty flag per band and one complete order materialization at successor dispatch
- mocked Obsidian vault adapter plus atomic save, failure, rename, external modification, pre/post-read identity and metadata guards, stale-size growth, file replacement, and per-path read/write serialization
- CodeMirror insertion plus undo file cleanup using mocked host adapters
- clipboard adapter plus worker-backed encoding and decoding, user-activation-preserving delayed `ClipboardItem` data, one interoperable `text/plain` system write, synchronous construction failure, rejected write, complete revision-delta synchronization, validation, ID remapping, stale session or basis-revision rejection, custom-format read compatibility, in-session fallback, and exact mouse, pen, or touch context-menu placement without repeated-paste offset
- unsaved edit followed by Copy and autosave, proving clipboard synchronization advances the worker model and fragment dirtiness, Copy encodes the edited record, a zero-delta export produces the complete current SVG, and dirty state clears only after its stable save operation is confirmed
- delayed Cut with an intervening edit, selection change, record replacement, detachment, and write rejection, proving each stale case may preserve copied data but removes nothing and creates no Cut history command
- document-worker failure during unlock, migration, clipboard encoding, paste decoding, export, preflight, and read-back, proving one worker-epoch invalidation, old-epoch prepared-successor rejection, new purpose-specific identity, no partial result adoption, equivalent bounded fallback output, no retry loop, and no live-gesture slice; a separate failure after `Vault.process()` begins and before read-back classification must retain the immutable old save proof, verify it under a new `verificationOperationId`, update the confirmed base without rewriting, and preserve a newer dirty revision
- native-scroll integration with a test scroller proving write-only acquisition followed by post-style measurement before input, one shared lease, retention across lock and unlock, `scrollbar-gutter: stable`, persistent desktop `overflow-y: scroll`, stable `clientWidth`, no nested vertical scroller, no right-gutter overlap, zero pointer-time style mutation, two-frame live-layout owner transfer, immediate true-unload release, fresh remount acquisition, and complete cleanup across Reading view, Live Preview, and pop-out ownership
- canvas navigation input proving that horizontal touch release uses every recent velocity sample, each horizontal-dominant unshifted pixel-mode trackpad event including an operating-system inertial tail applies the bounded cadence-aware speed response directly and feeds the same adjusted delta into the synthetic X-only release, direction reversal discards opposing samples, the release waits for a cadence-derived 8-to-40-millisecond missing-event window, samples and animation frames share the owning window's monotonic clock, direct and kinetic horizontal frames never write `scrollTop`, conflicting input cancels pending momentum, and dominant vertical touch plus wheel input remains unprevented and host-visible for native Obsidian kinetic scrolling
- presentation remount integration proving that an Obsidian-detached editor discards camera state and initializes its replacement directly at width fit without a fit-then-restore frame
- embed-width integration in ordinary, padded, readable-line, list, callout, max-width, and nested layouts, proving `containerWidth` uses the background container rather than pane width, overrun clamps before input, and toolbar plus input surface remain inside the owner client edge
- settings UI definitions plus persistence adapters
- Reading-view `MarkdownRenderChild` and Live Preview `WidgetType` lifecycle cleanup through host test adapters, including exact standalone custom-embed and resolved-document correlation, complete section-host replacement without any native or owned HTML image, restoration on unload, a full-width Live Preview block widget provided directly from a `StateField` rather than a forbidden dynamic plugin decoration, ordinary SVG non-interference, fail-closed CodeMirror syntax-tree boundaries for inline content, code, comments, escapes, and incomplete trees, preservation of the same widget while save-triggered reclassification is pending, and terminal-negative removal
- main-window and pop-out widgets sharing one coordinator, with simultaneous activation proving exactly one active session and one latest pending request
- multiple tabs referencing the same SVG, proving one reused document session, one attached presentation, and no duplicate store or worker
- repeated mount and unmount, note switching, worker creation and termination, and adaptive-menu lifecycle soak checks proving that every owned root, menu session, listener, observer, animation frame, worker, and host reference is released
- pending widget detachment before activation, proving cancellation without mounting and no retained DOM, `Window`, widget, or attachment generation
- dirty widget detachment during delayed export and vault I/O, proving immediate UI cleanup, continued headless save, latest-revision confirmation, and no detached DOM mutation
- same-session remount during a detached save, proving reuse of the existing store and worker, replacement of an older pending target, and clean reattachment after confirmation
- detached save failure, external conflict, same-embed recovery reattachment, workspace recovery modal routing, stale recovery after a same-document handoff and newer revision, and release only after current Retry, Reload, or Save local copy
- independent coordinator instances proving that cross-process-style concurrency reaches vault conflict handling rather than shared in-memory state
- Vault, FileManager, MetadataCache, Editor, and device-storage adapters for documented operations and failure fallbacks

Integration tests do not launch a complete Obsidian application.

### Performance Tests

All performance tests follow the [Unified Verification Model](performance-ci.md#unified-verification-model) and [authoring rules](performance-ci.md#adding-or-changing-performance-tests). They observe work/resources and simulated scheduling without measuring execution speed. Product latency targets remain separate physical-device requirements. Automated coverage includes:

- an exhaustive classified manifest, complete work/resource contracts, and all five supported profiles wherever cadence changes scheduling or input
- snapshot validation and parsing
- store construction and spatial-index insertion
- viewport query and hit testing
- spatial-query candidate counts, reused scratch-buffer allocations, and repeated page-extent updates after deleting the lowest element
- alternating bottom-element additions and removals against the 10,000-stroke fixture with zero full-store scans; growth/shrink transitions at all fixed profiles complete within their simulated frame-count bounds
- dense snap candidate lookup, absolute angular snapping at multiple zoom levels, table separator updates, and a 512-dependent transitive target transform
- all four arrange operations on an alternating 5,000-element selection in a 10,000-element band and order-only worker export
- oversized-element overflow indexing and queries
- bounded rendering and uniform transformation of a 10,000-element selection, plus complete handle-to-scene resize and coalesced S Pen move pipelines at 60, 90, 120, 144, and 240 Hz with four raw samples per frame, page growth, mixed exact geometry, connected structures, a 4,096-sample pressure transform, and the 10,000-element aggregate fallback
- frame-batched live pressure drawing at 60, 90, 120, 144, and 240 Hz plus indexed eraser sweeps with controlled frame scheduling, each with eight ordered raw S Pen samples per frame, one live-tail or feedback publication per frame, and no full-store scan
- rectangle and bounded freeform-lasso spatial broadphase plus Touched and Fully enclosed candidate classification against the 10,000-stroke fixture, with no full-store scan, bounded point storage, input-aware slices where required, and atomic selection publication
- one-stroke commit and incremental export
- direct validated Store hydration and serializer reuse counters proving that matching Store bounds reach incremental fragment assembly without duplicate geometry calculation, plus a one-pass export fragment list without repeated LRU mutation
- maximum clipboard codec and worker encode/decode with complete delta synchronization, stale-delta rejection, zero-delta export after Copy, purpose-specific operation identity, and bounded main-thread adoption slices; maximum-scale atomic Cut adoption and focused editor scenarios prove stale-result recomputation and delayed Cut cancellation
- worker failure fallback for validation, migration, clipboard, export, hashing, preflight, and read-back under continuous synthetic input; maximum-complexity Safe-SVG validation runs with a synthetic input sample at every checkpoint, and trusted-output tests prove cancellation at the production 64-KiB hash boundary
- 4,096-point live-stroke work, a maximum 16-sample mutable tail, finalized-prefix reuse, and direct scalar buffer reads without retained-sample object reconstruction
- full SVG serialization
- exact standard- and stress-fixture metadata, static-markup, total-byte, and bytes-per-point measurements
- peak main-plus-worker memory during full export, result handoff, vault writing, conflict recovery, and repeated coalesced saves
- steady-state one-stroke retained-memory growth, unchanged-record identity, and path-cache hit counters
- steady-state viewport candidate and hysteresis reuse, unchanged-membership sort suppression, applied SVG attribute-write counts, maximum-complexity dense mount slices, background-cache reuse, and bounded anchor-cache hit and eviction counters
- history memory bounds

The deterministic suite covers JavaScript work that can be measured without browser rendering. Actual style, paint, compositing, native host scrolling, and high-refresh input behavior are verified manually in Obsidian using the reference profiles because a simulated DOM does not provide trustworthy rendering timings.

## Coverage and CI Gates

Local and GitHub CI enforce the same [deterministic work/resource and scheduling contracts](performance-ci.md). Real-time comparisons, baselines, tolerance percentages, timing warnings, and statistical sampling are removed. A computation can become slower while its observed work remains unchanged; CI no longer detects that class of regression or establishes p99 latency.

Local npm checks use one exclusive loopback listener on `127.0.0.1:47839` across checkouts and worktrees. `ci` and `ci:quality` expand into their existing sequential steps under that single guard; standalone test, benchmark, lint, build, and other validation commands use the same guard. If the port is already occupied, the second command exits unsuccessfully before starting any tool. It does not wait, retry failures, skip tests, or change any acceptance threshold. A different service using that port also blocks checks conservatively. Normal completion releases the guard after the active tool exits. On POSIX, handled interruption signals the tool process group and waits for its running members to finish; Windows forwards the signal to the direct child only. After five seconds, remaining children receive `SIGKILL`; another second without confirmed shutdown, or an unverifiable group state, produces an explicit cleanup failure. Direct tool invocations, the development watcher, and unrelated applications are outside this cooperative guard; avoid competing heavy checks. Killing the runner forcibly can leave tool descendants running even though the operating system releases its port. Check for those processes before starting another check. Tooling files use the explicit `tsconfig.tooling.json` project for type-aware ESLint analysis, avoiding the default-project file-count limit without disabling lint rules.

Unit and Integration tests use isolated Vitest workers with `maxWorkers: "100%"`, allowing one worker per available CPU instead of leaving a CPU unused on small runners. The exhaustive table-rotation and aggregate SVG-capacity files form a separate serial group, so their existing deadlines do not compete with another test worker. Each file runs exactly once; all other quality files use the parallel group. Performance batches explicitly retain their single-worker override. This changes execution scheduling only: local and hosted tests, coverage scope, thresholds, and required checks remain identical. Reuse immutable serialized fixture strings within a test file where setup is identical; create fresh mutable parser/session state for each case and retain complete capacity and boundary inputs.

Hosted CI runs the complete classified contract suite under [Performance CI](performance-ci.md). Pull requests and manual dispatches run the complete gate; post-merge main pushes do not repeat the tested squash tree, while release tags rerun it. Required check names remain `CI`, `Performance (shared)`, `Performance (refresh profiles)`, `gitleaks`, and `Validate PR Title`. Standard Ubuntu runners use Node.js 24 for quality and Node.js 26 for two performance shards. Performance files run serially with isolation. Local `npm run ci` includes the exact union of both shards. Missing, skipped, failed, or malformed results and operational timeouts fail. `npm run benchmark` runs these contracts without a reference checkout or measurement mode. Physical-device performance is not established by a green run.

Executable source MUST retain these project-wide coverage thresholds:

| Metric     | Minimum |
| ---------- | ------: |
| Lines      |     85% |
| Statements |     85% |
| Functions  |     85% |
| Branches   |     80% |

The hard ESLint gate fails on functions over 100 lines, files over 500 lines, cyclomatic complexity over 20, cognitive complexity over 25, more than 6 parameters, or nesting deeper than 4 levels. Reviewers still assess large or complex units for clear responsibilities, cohesion, and readability, but the project does not emit a second set of arbitrary lower numeric warnings.

TypeScript and TSX source filenames use `kebab-case`; executable tests use `*.test.ts`, `*.test.tsx`, or `*.test.mjs`. Types, classes, and React components use `PascalCase`; functions, methods, and variables use `camelCase`; genuine module constants use `UPPER_CASE`; public exports use meaningful names without interface-style `I` prefixes or unnecessary defaults. ESLint enforces identifier and export rules, while the source-layout gate enforces filenames, test suffixes, Scene TSX absence, and the 500-line CSS limit.

The dependency-cruiser gate evaluates the complete `src/` graph including TypeScript type-only edges. It rejects every cycle and every import that violates the documented `domain`, `editor`, `rendering`, `persistence`, `obsidian`, and build-entry directions. The Scene-specific ESLint gate rejects React, ReactDOM, JSX, TSX, React-owned UI imports, roots, portals, state APIs, selector queries, and descendant DOM walks while allowing imperative DOM and SVG. The entry-based worker typecheck uses `ES2021` plus `WebWorker` and excludes DOM, `Window`, React, Obsidian, and the main-thread worker factory. Stylelint verifies source CSS syntax, known properties, duplicate selectors, specificity, qualifying types, and nesting depth.

CI MUST run:

- formatting verification
- hard linting with project size, complexity, naming, mobile, Obsidian, and architecture-boundary rules
- source-layout and CSS linting
- complete import-graph cycle and area-direction verification
- main, test, and isolated worker TypeScript type checking
- Unit and Integration tests
- the project-wide coverage thresholds above
- `jscpd` with `minTokens: 50`
- `knip`, including a fatal production-only pass for unused files, exports, and types so source code reachable exclusively from tests cannot survive the gate; `ignoreExportsUsedInFile` keeps internally consumed module exports valid while still rejecting exports with no production caller
- dependency security audit
- production build and release-artifact verification
- deterministic schema fixture and performance benchmark suites
- a renderer-scoped lint restriction that rejects `querySelector`, `querySelectorAll`, and descendant selector walks in scene reconciliation

No gate may be bypassed through broad exclusions, empty assertions, raised limits, or disabled rules.

## Manual Release Checks

Manual checks are not smoke or end-to-end test suites. They are focused acceptance measurements for behavior that cannot be represented faithfully in the automated harness:

- pen latency and palm rejection on one supported stylus device; on affected Linux pen hardware, record the Obsidian/Electron version and Wayland or X11/XWayland backend and verify native crosshair selection separately from SVG icon and ring feedback. CSS cursor selection may not control a separately managed tablet-tool cursor. Xvfb and synthetic pen events do not establish physical S Pen behavior
- touch arbitration and pinch on iOS and Android
- mouse, trackpad, keyboard, and focus behavior on desktop
- delayed Copy, Cut, and Paste on supported desktop, iOS, and Android WebViews, covering the successful prefixed `text/plain` system representation, synchronous `ClipboardItem` construction failure, rejected system write, custom-format read compatibility, in-session fallback, and no Cut removal after an intervening edit, selection change, or detachment
- right-hand native Obsidian scrollbar behavior before, during, and after pen drawing in Reading view, Live Preview, and a pop-out: persistent desktop track where the operating system exposes one, unchanged gutter and `clientWidth` everywhere, no overlay by Inkbook UI, and recorded OS-controlled auto-hide behavior on native overlay-scrollbar systems
- mouse, touch, and keyboard canvas context menus with the specified icons, disabled Arrange boundaries, and red text plus icon for destructive entries
- active-scene, Reading-view, Live Preview, and saved-SVG graphic parity in light and dark schemes, including a pop-out window and one external vector editor; software without media-query support must show the deterministic light fallback
- host-theme chrome, high contrast, and reduced motion
- first appearance after insertion and note opening in Live Preview and Reading view, including pointer-through loading indicators and partial-preview remount continuity, frames before placeholder mounting, late source-path assignment without document changes, zero-to-48-pixel placeholder growth and early replacement from its current height, shared spinner timing and uninterrupted automatic-activation handoff, later manual activation with a fresh delay, placeholder/intermediate/final heights, cached zero-height appearance, failed recognition restoration, sequential autoactivation, reduced motion, width retargeting, occurrence retention across remounts, and disposal before readiness
- bounded recognition admission, completion-time cache eviction, faulty subscribers, cancellation, long-note insertion validation, and maximum-capacity Live Preview prose edits and coalesced recognition bursts
- 10,000-stroke frame, memory, unlock, animation, and export budgets
- in-place lock and unlock with identical root, width, attachment, and top-edge anchor; the same block animates once between exact locked and active heights without duplicate insertion, stale preview border, flicker, unintended scroll jumps, or editor remounting; unlock hides the preview and exposes the complete active scene, foreground, toolbar, and input in the first growth frame while retaining the hidden preview until cleanup; coverage includes active-at-native-bottom lock, retained-range editor disposal, direct unlock without intervening scroll, and deliberate-scroll reserve release
- unlock, committed content growth, window resize, zoom layout, and eraser-driven shrink at several intermediate frames, including a top-row-only document, fractional CSS-pixel rounding, and one-step growth larger than two initial viewports, proving that the prepared envelope is aligned to writing rows, never shorter than the visible canvas, stays top-anchored, waits for a complete renderer frame before growth, progressively reveals the already complete pattern, performs zero background builds during clipping, and leaves exact final height and scroll compensation after interruption
- every background type and S/M/L/XL spacing, including rapid S/XL/M/S preview retargeting, proving that active height, current container block size, camera, and native scroll position remain unchanged while pattern geometry updates atomically, and that commit updates the next locked target
- successful eraser removal keeps every affected path at its final fade state until the same scene barrier detaches it, creates no exit tombstone, and never restores stale opacity or geometry before an automatic shrink begins
- empty locked previews with at least 2.5 writing lines rounded to the next writing row, no clipping by host button sizing, and the same minimum after reload
- active and standalone SVG verification across every absolute S/M/L/XL spacing that the fixed inner frame never moves, squares retain all four outer boundaries, dots occupy the exact corresponding square intersections, lines retain only horizontal guides, the 100 / 3 spacing closes each canonical 100-unit row without a floating-point terminal sliver, a non-divisible final interval closes exactly at the right or bottom frame edge, both renderers share the same canonical axes and 25-percent-alpha palette, the active scene uses one bounded full-page pattern coverage path plus at most one terminal path, input remains available throughout the margins, and content entering the bottom margin restores a complete margin after growth
- attached save recovery restores the active page height and camera before presenting its compact icon-action overlay at the shared window-level feedback position, so all four writable SVG margins remain visible and no failed-lock measurement reads a released document page
- attached load and save recovery, retryable activation, insertion Undo, clipboard, history, copied-embed Paste, and embed action feedback use the shared status-icon surface with concise outcome-aware copy; presentation and non-presentation feedback share the owning window's upper-right desktop/tablet or upper-center phone overlay defined in [Embed UI](embed-ui.md), remain stable across scrolling, zoom, and resize, and avoid overlap between independent anchors; pop-out ownership and lifecycle cleanup are preserved, and identical-anchor messages replace instead of stack, and no retry, keep-preview, dismiss, undo, copy, reload, delete, or continue action substitutes a text button
- editor-interface startup failure produces one attached recovery surface without an additional native Obsidian notice, while failed or stale copied-embed Paste, clipboard read or encoding, rejected standard system clipboard writes, and failed Canvas history traversal produce the matching typed feedback without changing recoverable data; a rejected system write retains the validated in-session payload
- delayed loading and saving feedback under intentionally blocked worker and vault operations, including the 500-millisecond load boundary, the next-animation-frame pending-state recheck, completion between threshold and paint without a mounted loading flash, the 150-millisecond save boundary, an unknown unlock target height, atomic loading cleanup at scene handoff, exact-revision successor saves, Retry, immediate failure recovery, reduced motion, and cleanup on detach or plugin unload
- toolbar overlay and native-sticky behavior proving that activation adds no toolbar height, surrounding Markdown does not move, scroll-owner top padding is compensated without private selectors, the toolbar pins at the visible owner edge, and the embed bottom bounds its sticky lifetime
- confirmed persistence propagates the current locked aspect ratio to every mounted preview before resource refresh, so a non-empty patterned lock shrinks to the complete occupied pattern row plus exactly one pattern row, a background-free lock retains one trailing 100-unit writing row, and unlock grows back to the background-independent `activeHeight`
- synchronous and chunked worker parsing accept only the canonical fixed-frame background geometry and reject any partial or unknown static-path variation
- owned toolbar Overflow opening directly below its three-dot trigger; owned Background panel handoff and Back-to-Overflow actions through mouse, touch, keyboard, and native host-history Back and public keymap Escape dismissal; Settings and Keyboard-shortcuts actions, including retained phone sheet/host/backdrop identity, animated subpage height growth and shrink, rapid navigation interruption, and Back-to-Overflow before final dismissal; responsive shortcut recording, clearing, reset, Inkbook and effective Obsidian conflict feedback, and tab navigation; height-invariant live background-spacing preview, one final history and save commit, and atomic rollback after a rejected commit; owned Shape and Style surfaces; all 25 Arrow endpoint combinations; distinct 2D and 3D coordinate-system icons; rounded 44-pixel Style controls; exact primary-toolbar centering while context buttons appear; Canvas context-menu section separators with an icon on every actionable entry; straight-highlighter centerline handles, 90-degree line and arrow snapping, 45-degree coordinate-axis snapping, endpoint-to-endpoint connections, and table separator handles across desktop, tablet, and phone modes
- consecutive stroke commits, autosaves, resource refreshes, and theme changes without active-editor detachment, widget remount, focus loss, or session closure
- Reading view, Live Preview, Source mode, pop-out windows, settings search, enable, disable, and reload without leaked listeners, workers, scrollbar leases, host-element references, menu sessions, or React roots
- production editor-chrome module loading under Obsidian's default CSP in the main window and a real pop-out realm, including distinct owner-document React roots, toolbar measurement before input handoff, close-before-load cancellation, retryable CSP/import failure, timeout cleanup, and no retained Blob URL
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

[Implementation specification](specification.md), [File format](file-format.md), [Rendering and performance](rendering-and-performance.md), [Embed UI](embed-ui.md), [Zoom](zoom.md), [Settings](settings.md), and [Obsidian integration](obsidian-integration.md).
