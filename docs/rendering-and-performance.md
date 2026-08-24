# Rendering and Performance

## SVG Instead of a Bitmap Canvas

The active drawing area is an SVG.

All actual content is located within a camera `<g>`:

```
screenX = (pageX + camera.x) × camera.zoom
screenY = pageY × camera.zoom
```

`camera.y` does not exist in version 1. Vertical navigation is owned exclusively by the Obsidian note scroller.

Screen-relative overlays are located outside this transformed area:

- selection handles
- lasso
- eraser cursor
- pen cursor

This keeps handles and cursors the same size regardless of zoom.

## Live Stroke and Saved Stroke

While the pen is touching the screen, an imperative live-stroke group is updated directly.

The process:

1. `pointerdown` starts a point list.
2. `pointermove` adds all available coalesced pointer samples.
3. Samples that are very close together are merged or only replace the current tip.
4. Finalized geometry is appended to immutable preview chunks, while only a bounded mutable tail is rebuilt.
5. `pointerup` creates an `AddStrokeCommand`.
6. The same stroke is then rendered through the regular element store.

The live preview and saved stroke use the same path builder. This prevents them from differing because of two separate rendering methods.

The live builder MUST NOT rebuild the complete path for every sample. Each finalized preview chunk contains at most 256 retained samples. The mutable tail contains at most 16 retained samples, including four read-only boundary samples that preserve smoothing and tangent context but are not emitted twice. A new sample rebuilds only that tail and its boundary segment; it never reconstructs an older finalized segment. The renderer retains one tail `path` node for the complete gesture and updates only its `d` attribute; newly finalized chunk nodes are inserted before that stable tail. On commit, the chunks and tail produce exactly the same geometry as a one-pass build from the stored samples. Live input uses a geometrically growing numeric buffer and copies its samples exactly once into the committed immutable record.

Strokes with a constant width are rendered as an SVG centerline. Pressure-sensitive pen strokes are generated as a filled outline path.

## Deterministic Stroke Construction

New strokes store `smoothing: 0.5`. Input processing uses these rules for both the live path and committed output:

1. Convert each coalesced sample to page coordinates and reject non-finite values.
2. Merge a sample whose screen-space distance from the previous retained point is below 0.5 CSS pixels by replacing that previous tip. Always retain the first and final sample.
3. Smooth interior center points as `0.25 * previous + 0.5 * current + 0.25 * next`. Endpoints remain unchanged. The stored raw points do not change; smoothing is deterministic path construction.
4. Mouse and finger input always use simulated pressure: compute screen speed in CSS pixels per millisecond as `distance * zoom / max(1, deltaTime)`, set `target = clamp(1 - speed / 1.5, 0.25, 1)`, start at pressure 0.5, and set each later pressure to `0.7 * previousPressure + 0.3 * target`. Finite pen pressure is clamped to `0..1` and used directly; a non-finite pen sample is rejected.
5. Constant-width strokes use a round-capped SVG path through the smoothed centers, with midpoint quadratic segments for three or more points.
6. Pressure strokes use half-width `style.width * (0.35 + 0.65 * pressure) / 2`. At each center, calculate the normalized tangent from adjacent centers and its perpendicular, create left and right outline points, join each side with midpoint quadratic segments, and close them with semicircular end caps. A repeated center reuses the last valid tangent; a single point is a circle.

Commands first canonicalize stored samples as defined in [File Format](file-format.md). The serializer rounds only derived final SVG coordinates beyond that canonicalization. Path construction never reads current zoom except for the input merge threshold and simulated input pressure, so a later zoom change does not alter committed geometry.

## Imperative Scene Ownership

React owns only stable application chrome: the toolbar, flyouts, dialogs, notices, and coarse editor lifecycle. One imperative SVG scene renderer owns the camera group, committed content nodes, live previews, background geometry, culling, and overlays. React components MUST NOT render individual ink elements.

The following are updated by the scene renderer:

- the live stroke
- the camera transform
- the grid
- selection handles
- transformation previews
- eraser markings
- scroll compensation during zooming

Pointer-move, wheel, scroll, pinch, animation-frame, culling, snapping, and gesture-preview callbacks MUST NOT call a React state setter, notify a React-visible external-store subscription, create JSX, or wait for a React render or commit. A committed transaction may notify coarse UI subscribers once after the authoritative store and scene are consistent. A discrete selection, tool, or lifecycle transition may enqueue one coarse UI update after imperative input feedback completes, never one update per sample or animation frame. Subscribers receive only derived toolbar, selection-summary, history, save-status, and accessibility state.

The renderer coalesces scroll, resize, camera, store-delta, and observer invalidations into at most one pending scene update per animation frame. It discards stale queued work by generation. Within a frame, it performs all required layout reads first, then pure calculations, then DOM writes. It MUST NOT call `getBoundingClientRect()`, `getBBox()`, or computed-style and scroll-range reads after the first DOM write. Gesture-local container and scroller geometry is cached until resize, remount, or host-layout invalidation. `ResizeObserver` delivery is coalesced and unchanged sizes produce no scene update. Once the initial positive width is stable, each changed positive width updates the proportional camera zoom, page block size, viewport, and toolbar stage in the next coalesced frame. The outer presentation also listens to its owning window so an old inline-size clamp cannot prevent a growing pane from being remeasured.

Content bands and decorative canvas overlays use `pointer-events: none`. One focusable transparent input surface above the content uses `pointer-events: auto` and `touch-action: none`; it owns the canvas pointer, wheel, `contextmenu`, and keyboard event handlers. Toolbar controls, flyouts, and host menus remain above that surface with normal pointer events. The renderer resolves elements through the spatial index and selection handles through their bounded screen-space overlay geometry rather than browser SVG target lookup, so no content or overlay node owns an event listener. Context-menu behavior is defined in [Features](features.md#canvas-context-menus).

## Delta Domains and Applied Node State

Every published store delta classifies each affected ID with one or more domains:

- `geometry`: path commands, geometry-affecting width, bounds, anchors, or spatial membership changed
- `paint`: color, opacity, fill, cap, join, or dash presentation changed without geometry
- `order`: stable rank changed inside a render band
- `connection`: reverse-map membership changed; affected resolved endpoints also carry `geometry`
- `visibility`: creation, removal, or another change to mounted-set eligibility

The store assigns monotonic safe-integer `geometryVersion` and `paintVersion` values at command commit. It never hashes records in the render path. A paint-only command reuses path strings, bounds, anchors, and spatial cells. An order-only command touches rank and affected SVG child order only. Selection and hover are scene state and do not replace element records.

Each mounted ID-to-node entry retains the last applied geometry version, paint version, preview-transform version, render rank, and relevant serialized attribute values. The renderer writes `d`, `fill`, `stroke`, opacity, width, dash, cap, join, class, or `transform` only when the corresponding applied value differs. Camera-only and overlay-only frames MUST perform zero content-node attribute writes. A theme change updates the presentation root palette once and never walks content nodes.

## Frame Priorities and Dirty Flags

One frame may contain several dirty domains, but work is always attempted in this order:

1. live ink and current pointer feedback
2. camera transform, connected-endpoint preview, and screen-space overlays
3. changed nodes that are already mounted
4. visible-set exits, entrants, and affected order
5. background regeneration, nonessential animation, and cache prewarming

Separate dirty flags prevent an overlay-only frame from querying visibility and prevent a paint-only frame from rebuilding geometry. At measured checkpoints the renderer stops before lower-priority work would exceed the current interaction-frame budget, retains the last complete scene, and queues one successor frame. A live gesture pauses cache prewarming, background work that is not required for correctness, tombstone creation, and worker-result adoption on the main thread. No lower-priority task may delay pointer feedback.

## Viewport Culling

The store always retains every element. However, only elements returned by the spatial index that intersect the visible area plus exactly 80 screen pixels of overscan are mounted in the SVG DOM.

The visible area is the intersection of the active scene container and its resolved native scroll owner's client viewport. A document scroll owner uses the owning window viewport; a nested owner uses its client box. Scroll, resize, and layout changes invalidate this measurement, which is clamped into container-local coordinates before zoom conversion, spatial lookup, and background coverage. Culling MUST NOT substitute the complete embed rectangle or a stale `scrollTop` estimate for that actual intersection.

Exceptions:

- Visible selected elements remain mounted. Offscreen selected elements are represented by one aggregate selection-bounds overlay and remain unmounted.
- During a transform, at most 256 selected paths closest to the viewport are mounted as an active preview subset. The remaining selected elements use aggregate bounds during the gesture and receive the same canonical transform once on commit.
- Export and saving always use the complete store.

This allows the 10,000-stroke acceptance document to remain interactive without mounting every complex SVG path at the same time.

The renderer diffs the new visible-ID set against its ID-to-node map and mutates only entering, exiting, changed, or affected reordered nodes. It MUST NOT replace a complete render-band group, rebuild unchanged paths, or traverse the complete store during an ordinary viewport update. Large viewport jumps may reconcile entrants and exits in input-aware time slices while retaining the last complete frame. Preview nodes, animation tombstones, and crossfade nodes count toward the mounted-node ceilings.

Element IDs receive stable session-local numeric slots. Current visibility, next visibility, candidates, entrants, exits, and deduplication use reusable slot buffers plus epoch markers or bitsets; an ordinary frame allocates no replacement `Set`, full candidate array, or full visible array. The candidate union is cached while the viewport-plus-overscan intersects the same spatial-cell range and is patched or invalidated by relevant geometry deltas. Exact bounds rejection still runs for the current viewport, so candidate reuse never expands the mounted 80-screen-pixel overscan. Deleted slots are cleared before bounded reuse, and every buffer is released with the session.

The normal mounted-node ceilings in [Quality and Testing](quality-and-testing.md) are acceptance budgets for the standard fixture, never permission to omit visible elements. If an adversarial dense viewport exceeds them, the renderer enters dense-reconciliation mode: it removes nonessential tombstones, disables prewarming and entrance animation, evicts offscreen LRU entries, prioritizes hit elements and existing nodes, and mounts every remaining exact visible entrant in input-aware batches. A mount slice uses the frame's absolute deadline and stops before exceeding either 4,096 stroke points or 16,384 geometry-cost units, while still admitting one element so a maximum-complexity stroke cannot starve. Its persistent band-and-rank cursor reuses the current visibility query until a viewport or relevant visibility change replaces that work. Rank changes reorder the current snapshot, and a hit on a not-yet-mounted visible element promotes it into the next batch without changing final order. Version 1 does not rasterize, merge overlapping interactive elements unsafely, or silently hide them.

## Path Caches

Bounds and path-cache entries store the element ID and `geometryVersion` that produced them. A hit requires the same geometry version. A changed geometry invalidates only its own entry and automatically re-resolved dependents; paint, order, selection, and theme changes do not.

Additionally:

- Bounds remain available for every indexed element, but main-thread path strings are retained only for mounted elements and a recently unmounted least-recently-used cache capped at 4,096 entries and 32 MiB, whichever is reached first.
- Unlock constructs paths only for the initial visible area plus overscan and MUST NOT eagerly construct paths for all elements.
- A translation preview uses an SVG transform.
- The actual outline path is recalculated only after the canonical move commit, not during pointer movement.
- Square and ruled backgrounds use one cached compound guide path for the visible vertical area plus overscan when that path stays within the 2,048-segment bound. Dots and pathological guide counts reuse one fixed SVG pattern tile and one bounded coverage path.
- Page height uses the shared conservative element bounds. Bounds may overestimate but must never underestimate visible geometry.
- Removed or replaced cache entries are released immediately. The worker owns a separate bounded serialized-fragment cache; main-thread and worker caches do not share ownership.

The scene keeps no duplicate DOM metadata that already exists in the ID-to-node map. A stroke or simple shape uses one `<path>` whenever its paint semantics permit. Tables, coordinate systems, and compatible arrow subgeometry use compound subpaths rather than one node per line. A small fixed number of sibling paths is allowed only when different fill and stroke semantics require it; an element receives no wrapper `<g>` unless a multi-node preview transform requires one. Content rendering uses direct node references, never `querySelector()` or descendant selector walks. Contiguous entrant or reorder runs are prepared in an SVG-compatible `DocumentFragment` and inserted at their exact rank without replacing a band. Filters, masks, shadows, blend modes, external resources, and per-element CSS selectors are forbidden for ordinary ink.

## Background Geometry Cache

Each presentation owns one namespaced SVG `pattern`, one bounded pattern tile, and one current background path. Centered bounds contain the greatest whole number of intervals that fit inside the writable area and divide every remainder equally between opposite sides. Ruled and square backgrounds normally materialize their visible guides into one cached compound path with the same direct geometry and scale-independent one-screen-pixel stroke as the standalone SVG. Guide paint uses normal SVG antialiasing and a 25-percent-alpha, scheme-specific neutral instead of `crispEdges`; this prevents fractional zoom and device scale from rounding neighboring guides into visibly different widths or intensities. The path spans only the true visible vertical range plus one viewport of overscan, includes terminal square boundaries, and is capped at 2,048 guide segments. Dots and any pathological request above that cap use the fixed `userSpaceOnUse` tile plus one bounded coverage rectangle; the pattern stroke width is derived from the current zoom instead of relying on browser support for `vector-effect` inside pattern content. The fallback prevents unbounded path construction without affecting ordinary viewport parity.

The locked surface does not use an externally scaled CSS image because Chromium applies that outer image scale after SVG non-scaling-stroke evaluation, producing subpixel guide widths and phase-dependent intensity. Recognition time-slices strict safe-envelope inspection, retains validated source only in an LRU cache bounded to 256 entries and 32 Mi code units except for one individually valid larger document, and imports presentation markup only for a recognized visible block. Before import it removes the potentially large editable metadata and standalone stylesheet. The resulting inert SVG owns the fitted viewport directly; scoped light/dark rules then apply the same guide color and non-scaling stroke as the active scene. No React root, event handler, pointer target, object, iframe, script, URL-bearing SVG node, or native image exists in this path.

The geometry cache key is `{ backgroundType, spacing, innerWidth, margin, centeredBounds, firstVisibleIndex, lastVisibleIndex }`; theme is paint and is not part of the key. Scroll and height changes regenerate the background `d` only after the aligned first or last covered index or a centered bound changes. A background setting, page width, margin, centered bound, aligned index, or bounded direct-versus-pattern decision replaces the single entry, and the previous string is released immediately. Background work remains below live input and already mounted content in frame priority.

All individual cache caps are maxima, not reservations. The active-document memory ceiling in [Quality and Testing](quality-and-testing.md) overrides them and forces earlier least-recently-used eviction.

## Page-Height Rendering Handoff

Automatic active-page growth and shrink use one bounded 180-millisecond animation-frame transition owned by the layout adapter. The SVG scene is pinned to `max(startHeight, targetHeight)`, remains top-anchored, and is clipped by the outer rounded background container. React does not participate, and no content node is recreated merely because page height changes.

For growth, the renderer receives the target page height first. The container remains at its current height until the renderer reports a complete scene commit and that committed scene has remained available for one paint opportunity. Only then does the outer container reveal the already complete larger scene. For shrink, the renderer retains the larger page surface while the outer container clips it; the renderer receives the smaller page height only after the container reaches the target. Container height, native-scroll compensation, and layout invalidation are written together in each transition frame. A new gesture, reduced-motion change, lock, or disposal resolves or cancels the bounded transition without leaving a pinned scene envelope.

## Ordering, Snapping, and Connections

The renderer derives the highlight and content bands from element kind and mounts each band in snapshot order. An arrange command updates only stable rank data and the affected visible SVG child order. It does not rebuild paths, bounds, or spatial-index cells. Hit testing and equal-distance snap candidates use the same front-to-back ranks.

Endpoint snap lookup queries the existing spatial index with a page-space square that encloses the input-specific screen radius. It generates anchors only for eligible returned targets, then compares exact screen-space distance. It never scans the complete element array. Snap markers are overlays outside the camera group and remain screen-sized.

Eligible target anchors use a main-thread LRU keyed by target ID and `geometryVersion`. Entries store only canonical semantic anchor identifiers and page-space coordinates. Paint, order, selection, and theme changes are cache hits. Geometry replacement or target deletion releases the old entry. The cache is capped at 4,096 targets and 8 MiB, whichever is reached first, and the active-document memory ceiling may evict earlier. Candidate lookup still performs exact screen-space distance and deterministic tie resolution on every gesture frame.

The store maintains one derived reverse connection map keyed by target ID. A target geometry preview reads only that target's bounded dependent list and directly updates visible connected line or arrow paths in the same animation frame. Commit replaces the target and affected linear records, recalculates their shared bounds, and updates their spatial-index entries atomically. Unchanged dependents retain stable identity. The map is rebuilt once during validated document load and maintained incrementally thereafter.

## Spatial Index Bounds

The sparse uniform grid uses 256-page-unit cells. An element is inserted into every intersected cell only while that requires at most 256 cells. A larger element is stored once in an overflow collection, never expanded across all covered cells. The file format caps that collection at 512 elements and caps all retained grid memberships at 262,144 cells per document. Store construction, clipboard adoption, insertion, and replacement preflight the aggregate before allocating cell buckets. Every query checks intersecting grid cells and the overflow collection, then performs exact conservative-bounds rejection. Removal and geometry commits update the index atomically. Adversarial million-unit strokes and shapes are covered by the performance fixtures.

For every non-overflow element, the index retains its current cell keys so removal and replacement never scan grid buckets. Each interaction reuses owned candidate and deduplication scratch buffers instead of allocating full-store arrays or one result set per cell. Selection stores IDs rather than copied records. Its bounds are calculated when membership changes and transformed algebraically during a preview; pointer frames allocate no replacement records.

The same index owns a versioned maximum-bottom heap for page extent. Geometry replacement pushes one new `(bottom, id, recordVersion)` entry; extent lookup lazily removes at most 256 stale heads per frame and compares a valid head with overflow bounds. While cleanup remains, page height may conservatively overestimate but never underestimate content. When stale entries exceed the live indexed count, a time-sliced rebuild replaces the heap. Page growth, shrink, and deletion of the lowest element therefore never scan the complete store or create an unbounded cleanup task on an interaction frame.

A handle-based selection transform affecting more than 1,000 elements, more than 16,384 aggregate geometry samples, or more than the synchronous reverse-dependent budget materializes only changed immutable records plus incremental spatial-index and reverse-connection patches in input-aware slices while the final preview transform remains visible. Reverse-dependent counting stops as soon as a budget is exceeded and never scans the complete store. Draft construction, connection propagation, candidate classification, and patch preparation each check the same gesture generation and cancellation token before and after every yield. Preparation leaves the authoritative map, index, reverse map, and unchanged record identities untouched. The final synchronous transaction rechecks and consumes its one-shot token, applies only the prepared patches, publishes one delta, and then removes the preview. Cancellation or stale work discards the detached patches. No partially transformed store is observable. A translation initiated by dragging selected content uses the same sliced path above 1,000 elements; its transform-only preview does not require per-element sample materialization.

## Document Worker, Autosave, and Export

Every committed content change schedules:

- incremental export and save after 500 milliseconds of content inactivity

There is no periodic full-snapshot export. The validated unlock state initializes the worker baseline, and only a gap, restart, timeout, invalid order, validation failure, or explicit mismatch recovery permits another full snapshot. A recovered output does not write the vault file again when the same revision is already confirmed and its output hash matches.

Camera, zoom, scrolling, focus, hover, and animation changes do not dirty the file. If drawing or transforming is still in progress, saving waits and checks again every 200 milliseconds until the gesture transaction commits or cancels.

The single document worker starts when a document session begins unlocking and remains owned by that session lifecycle, including a detached-save lease. It terminates only after the session is clean and released or recovery reaches a confirmed terminal outcome. There is no worker pool, per-window worker, renderer worker, or second document worker. Before a full read, the main thread rejects a `TFile.stat.size` above the total file limit. It then obtains one `Vault.readBinary()` buffer and transfers ownership directly to the worker. The worker incrementally decodes UTF-8 chunks through one bounded non-networked XML tokenizer. It retains only the bounded root and metadata text, hashes the original bytes incrementally, compares each static group with the canonical generated fragment stream, and discards supplied static path text before decoding the next chunk. It never joins the complete SVG or keeps static input ranges. Before native JSON materialization it performs a string-aware structural width and depth preflight. The bounded fallback uses the same tokenizer and repeats those checks while parsing, before decoding another object key or appending another container entry, and decodes strings through one reusable 16,384-code-unit scratch buffer. It then performs schema validation and all remaining limits. The input buffer, metadata string, and parser scratch are released at the earliest stage that no longer needs them. The main thread performs none of those full-file operations during normal unlock.

When a validated snapshot uses an older supported version, the same worker applies the sequential pure migrations to its parsed representation before creating runtime batches or an export baseline. Migration revalidates the resulting current-version schema and limits. A stale activation generation, migration error, or post-migration validation error publishes no partial runtime state and leaves the original file unchanged in a read-only static state. The first later write still follows the backup rule in [File Format and Geometry](file-format.md#versioning-and-migration).

The static preview stays visible while the worker builds immutable snapshot fragments and converts each stroke into one worker-owned canonical `Float64Array`. The completed snapshot validation calculates each element's conservative bounds, spatial membership count, overflow classification, and document maximum bottom in the same pass that enforces those limits. That revision-bound derivation bundle is transferred beside the corresponding runtime element batches and is adopted by the worker serializer and detached main-thread store builder. Both receivers recheck element IDs, finite ordered bounds, batch alignment, and spatial-capacity consistency, but they do not rebuild element geometry merely to rediscover the same bounds. The spatial index still constructs its required cells from the validated bounds. After metadata structure, schema, sequential migration, root version, revision, and derived locked height validate, the worker may begin transferring hydration batches while it continues comparing the remaining supplied static groups with canonical fragments. These batches are staging input only: the main thread appends them to a detached builder, applies backpressure per batch, and cannot publish a store, enable input, or hide the static preview before the terminal result confirms complete static integrity, exact batch totals, and the source hash. A later mismatch, cancellation, stale identity, derivation mismatch, or terminal-count error cancels the builder and releases every staged record. Each transfer uses distinct typed-buffer copies capped at 256 elements and 4 MiB, whichever is reached first, and never transfers the worker-owned regeneration source. The main-thread receiver independently verifies both limits and adopts only exclusive full-span buffers, then time-slices index construction and publishes no partial document. The first interactive frame waits for all validated runtime records, the complete index, and visible paths, not for complete static export geometry. The worker builds remaining static-SVG fragments at background priority, then releases parsed JSON point arrays as soon as the canonical buffers exist. This initializes the export baseline without a second JSON parse, a second complete snapshot validation, or duplicate bounds construction; both canonical buffer copies and the transient parsed representation count toward the memory ceiling. Shape records may use structured clone in the same bounded batches. If the Worker API is unavailable or construction fails, the session uses the same pure operations in the bounded fallback defined below and reports fallback unlock timing separately. The worker:

- validates and migrates the file during unlock before runtime publication
- initializes from the validated unlock snapshot and receives a complete snapshot only for recovery
- serializes and validates clipboard payloads, including paste limit checks and operation-local ID remapping
- subsequently receives only changed or removed elements for SVG export
- keeps its own bounded outline and serialized-fragment caches warm
- hashes and validates preflight and read-back file content
- discards results whose session, worker epoch, or operation identity is stale

Every worker message is untrusted at the receiving boundary. Before adoption, the main thread validates the purpose-specific discriminator and identity, ordering and batch totals, exclusive full-span `ArrayBuffer` ownership, and the applicable element and byte limits. A complete SVG result additionally remains ineligible for `preparedSuccessor` or persistence until receiver-side inspection enforces the 64 MiB limit, recomputes the hash from the exact received UTF-8 bytes, verifies the reported hash, and passes the safe standalone-SVG allowlist and revision check. Any failure invalidates that result without publishing runtime state or writing it.

The worker's `modelRevision` is the document revision of its atomically applied canonical records, order, page state, and fragment dirtiness. It is independent of the main thread's last vault-confirmed revision and does not imply that SVG output has been assembled or persisted.

Clipboard API access remains on the main thread because it depends on browser user activation. On Paste, it accepts at most 256 clipboard items, inspects every supported candidate's `Blob.size`, rejects any representation above 8 MiB and a combined custom-plus-plain budget above 16 MiB before the first `Blob.text()`, then verifies decoded UTF-8 bytes again. An over-limit system clipboard does not fall through to an unbounded `readText()` call and changes no editor state. For Copy or Cut, the main thread first attempts to construct a `ClipboardItem` containing the standards-prefixed custom format and `text/plain`, without using `ClipboardItem.supports()` as a custom-format gate. A synchronous construction error immediately falls back to a `text/plain`-only item. It starts `navigator.clipboard.write()` during the same activation with data promises resolved by the worker result; a later rejected write leaves the validated in-session payload as the only fallback and never triggers a late unauthenticated retry. Before the codec runs, the main thread synchronizes the complete revision delta not yet present in the worker, including changed records, removals, render-band order, and page state, through the same bounded protocol used for export. This atomically advances `modelRevision`, updates or invalidates the affected snapshot and SVG fragments, and marks that model revision as needing output; it does not acknowledge an export, clear dirty state, or remove the scheduled save target. A later export at the same `modelRevision` may therefore assemble correct complete output with a zero delta. Copy and Cut then send selection IDs rather than cloning a complete selection, and the worker returns the custom and `text/plain` payloads from its current canonical records.

Every clipboard request and result carries `{ sessionId, workerEpoch, clipboardOperationId, basisRevision }`. Paste transfers the untrusted clipboard bytes or text to the worker, which parses, validates, remaps IDs and internal connections, applies the requested placement, and validates resulting document limits before returning immutable insertion records. The main thread rechecks all four identity values and current document limits before one atomic paste command. A stale Paste result changes nothing and is recomputed from the current revision if the user action is still pending.

Cut additionally captures the exact selected IDs and each selected record's identity or `geometryVersion` and `paintVersion`. After the exact payload reaches the system clipboard or the validated in-session fallback, and immediately before removal, the main thread rechecks the session, worker epoch, clipboard operation, basis revision, current selection, and every captured record. If any value changed or the presentation detached, the copied payload remains available but no element is removed, no Cut history command is created, and a notice reports that Copy succeeded but Cut was cancelled because the selection changed. Only a fully current operation removes the captured selection in one command.

The worker runs one non-preemptive job at a time. Unlock validation and migration are exclusive until activation completes. Thereafter required lock, recovery, preflight, and read-back work has priority, followed by one explicit clipboard operation, a due coalesced autosave export, and background fragment prewarming. A second clipboard action cannot start until the first reaches a terminal result, and UI availability reflects that state. Export retains its single coalesced successor below; background work is interruptible and retains no queue entry. This bounds queue length and prevents background work from delaying data-safety operations.

DOM creation and mutation, React, pointer arbitration and capture, live-stroke construction, camera and scroll handling, layout, viewport culling, hit testing, snapping, the spatial index, command history, Vault and Clipboard API calls, and Obsidian lifecycle work remain on the main thread. Moving them into a worker would duplicate authoritative state, transfer viewport-sensitive data per frame, or add latency to the live-input path. The initial spatial-index build, a selected-content translation above 1,000 elements, and a handle transform above either its 1,000-element or 16,384-sample cap remain input-aware main-thread slices unless the required benchmarks later fail; that evidence is required before changing this boundary.

Worker result identity is separated by purpose. `workerEpoch` identifies the current worker instance or synchronous-fallback executor and changes only when that executor is replaced or invalidated. `exportGeneration` is a session-local safe-integer counter incremented only when an SVG export is dispatched, and that dispatch assigns `newestDispatchedExportGeneration`. An export result not yet admitted to persistence occupies at most one replaceable `preparedSuccessor` slot. Admission creates the single non-replaceable `activeSaveOperation`, whose `saveOperationId`, revision, complete-output hash, and write phase remain unchanged through preflight, `Vault.process()`, and read-back. Unlock, migration, clipboard, background, and verification recovery use their own operation IDs and never advance `exportGeneration` or replace an active save. Timers and queued work own none of these identities; merely scheduling or firing the 500-millisecond timer never invalidates in-flight work.

Revision is a non-negative safe integer and increments exactly once for each committed content or page change, including Undo and Redo when they alter persisted state. Session-only changes and no-op history traversal do not increment it. Reaching `Number.MAX_SAFE_INTEGER` makes the document read-only until it is duplicated into a fresh revision sequence.

The main thread serializes worker state transitions. At most one export request, one `activeSaveOperation`, one `Vault.process()` call, and one `preparedSuccessor` may exist per document session. While export is in flight, later commits coalesce into exactly one pending target revision: changed elements use last-write-wins by ID, removals override changes, each band stores only a dirty flag, and page state retains only its latest value. The latest complete order for a dirty band is materialized exactly once when the successor dispatches, never once per intermediate reorder command. A baseline-invalidating condition upgrades that pending request to a full snapshot and never creates another queue entry. Export computation for a newer revision may overlap an active save's vault I/O, and its latest valid result may replace only `preparedSuccessor`; `newestDispatchedExportGeneration` never invalidates `activeSaveOperation`. No successor enters preflight until the active save finishes classification and updates the confirmed vault base. Writes to the same file remain serialized.

A full export request contains `{ sessionId, workerEpoch, exportGeneration, baseModelRevision: null, modelRevision, snapshot }`. An incremental export request contains the same identities plus `{ baseModelRevision, modelRevision, changedElements, changedElementDerivations, removedIds, orderChanges, page }`; a zero-delta export omits those delta fields when the worker already holds `modelRevision`. Each optional derivation belongs to the same delta and element revision as its changed record. Coalescing retains it only while that exact latest changed record remains authoritative; a later change without a matching derivation drops the stale value. The worker validates the changed element schema, recomputes its conservative bounds once as part of delta validation, and requires an optional Store derivation to match those bounds and its spatial-capacity facts before reusing it for aggregate facts, page extent, fragment bottoms, and export. This verification preserves the untrusted worker boundary while eliminating later duplicate bounds calculations. Missing derivations safely use the same single geometry calculation. Page deltas receive isolated complete page-schema validation. Connection-affecting deltas receive complete aggregate-limit and semantic target, anchor, fanout, and endpoint-position validation over the already validated runtime records, without revalidating every unchanged stroke sample or recalculating every unchanged bound. `baseModelRevision` is the last canonical model revision successfully applied by the worker, whether through export or clipboard synchronization. `orderChanges` is empty or contains the complete ordered ID list for each changed render band. A result returns the same identities and model revision plus complete SVG output, output hash, or a structured error. The main thread assigns `saveOperationId` only when it admits a prepared export to `activeSaveOperation`.

The worker accepts a state delta only when `baseModelRevision` equals its `modelRevision`, applies records, removals, order, page state, and fragment invalidations atomically, and advances `modelRevision` only on success. When several commits occur before dispatch, `changedElements` contains the latest form of every ID changed since `baseModelRevision`, including connected lines or arrows re-resolved by target changes. `removedIds` contains IDs absent at the target revision, and the two sets are disjoint. An order-only command sends no fabricated geometry change but includes its changed band in `orderChanges`. A gap, worker restart, timeout, invalid order, or error invalidates the model baseline and requires the next state-bearing request to contain a full snapshot.

Before an export result may enter `preparedSuccessor` or become `activeSaveOperation`, its model revision must still equal the current document revision, its worker epoch must be current, and its export generation must equal `newestDispatchedExportGeneration`. Promotion from the prepared slot repeats all three checks; a stale prepared result is discarded while the latest in-flight or coalesced export remains pending. Immediately before `Vault.process()`, the active save rechecks its exact preflight base and that its revision still equals the editor revision. Before that write begins, a newer edit terminates the unwritten active save and permits only a newly current prepared or coalesced successor to replace it. Once `Vault.process()` begins, later edits or export generations cannot invalidate the active save or its mandatory read-back. Every normal phase checks the session and `activeSaveOperation.saveOperationId`, not `newestDispatchedExportGeneration`.

A confirmed active-save read-back always advances the session's confirmed vault base revision and hash to that written result, even when the editor has advanced and a prepared successor exists. Dirty state clears only when the current editor revision equals the confirmed active-save revision. Otherwise the document stays dirty, the successor later preflights against the newly confirmed base, and a detached-save lease remains until the exact latest authoritative revision is confirmed. Complete-file parsing or hashing is never performed synchronously on the main thread.

Worker bootstrap, clipboard revision synchronization, full-recovery preparation, export assembly, UTF-8 encoding, and SHA-256 hashing are input-aware and time-sliced in both the production worker and fallback executor. Point-heavy worker copies use packed typed buffers and transfer ownership of those copies without detaching buffers owned by the editor store. Small incremental records may use structured clone only while measured dispatch work remains within the applicable 8-millisecond desktop or 12-millisecond mobile main-thread budget. The deterministic reference comparison measures cloned strings against transferred UTF-8, including sender encoding, structured transfer or clone, and receiver adoption, for both reference profiles. Transferred UTF-8 has the lower measured median and is therefore the version 1 complete-export wire format. CI records both distributions and fails if the selected representation no longer wins. Decoding, joining, hashing, validation, and adoption count fully toward the applicable slice budget.

The worker retains at most one current serialized snapshot fragment and one current static-SVG fragment per element. The fragment-pair cache is least-recently-used and capped at 20,000 elements and 64 MiB; an evicted fragment is regenerated from the worker's current element record when output assembly next needs it. An incremental request rebuilds fragments only for changed elements, removes deleted fragments, and reuses unchanged fragments. Order-only changes rebuild no element fragment; page-only changes rebuild only root and background fragments. One export resolves its ordered fragment-reference list once and reuses that list for byte accounting, metadata hashing, render-band emission, and metadata emission; those phases must not repeatedly touch and reorder the LRU map. Complete output is assembled deterministically but is never cached for zero-delta reuse; a later zero-delta export reassembles from the bounded current fragments.

Every successful export wire result creates exactly one acknowledgement lifetime keyed by `{ requestId, sessionId, workerEpoch, exportGeneration, modelRevision }`. The receiver sends `accepted: true` only after exact identity, transferred-buffer ownership, byte limit, hash, safe-envelope, and revision checks succeed; rejection, orphan or stale delivery, adoption cancellation, dispatch failure, executor termination, or the 30-second acknowledgement timeout closes the lifetime with `accepted: false`. The worker accepts only the exact current identity, ignores late or mismatched acknowledgements, and retains at most one unacknowledged identity without retaining the complete output. Encoding transfers ownership of the result buffer, and all sender-side complete strings, chunks, and buffers become unreachable after post, acknowledgement, replacement, rejection, or termination.

Serialization accounts for actual UTF-8 bytes incrementally. Static envelope, metadata prefix, background, and each reused or rebuilt element fragment reserve against separate metadata and 64 MiB output budgets as they are collected; exhaustion returns a structured limit failure before retaining a complete output. Chunked assembly independently re-enforces the total byte limit while hashing the exact emitted bytes. Estimated character counts or a final post-allocation length check alone are insufficient.

If Worker construction fails, a worker crashes, its protocol is violated, or it times out, the coordinator invalidates its `workerEpoch`, terminates it, and switches exactly once for the current session to the same pure validation, migration, clipboard-codec, export, hashing, and persisted-output verification algorithms on the main thread under a new epoch. This fallback yields between input-aware slices of at most 8 milliseconds on desktop and 12 milliseconds on mobile, pauses while a live gesture is active, and never performs DOM or Obsidian API work inside a computation slice. Safe-SVG path validation resumes inside one path after at most 16 KiB, 256 commands, or the current slice deadline; trusted-output hashing checks cancellation between 64 KiB chunks. A partial path or hash is never accepted.

Failure before `Vault.process()` begins discards partial computation and restarts the affected unwritten operation under the new epoch and a new purpose-specific operation ID. Epoch invalidation also discards any old-epoch `preparedSuccessor`; the authoritative main-thread model later regenerates it. Failure after the write begins, after it succeeds, or while its outcome is indeterminate MUST NOT discard or repeat that write. The coordinator retains immutable `{ saveOperationId, revision, outputHash }` proof from `activeSaveOperation`, creates a new `verificationOperationId` under the new executor epoch, reads the file through `Vault`, and classifies it against that proof and the previously confirmed base. Matching revision and bytes confirm the old save and update the confirmed base without another write; an unchanged prior base permits a retry; every other result is an external conflict. The worker is not recreated until a new document session, so repeated failure cannot create a retry loop.

Each persistence pass atomically writes one complete SVG file with one matching snapshot revision. “Incremental” refers to worker computation, never a partial file write. Autosaves write compact XML and compact JSON. Pretty-printing is intentionally avoided because reformatting large SVG files during a write would cause noticeable pauses.

Static export MAY merge only consecutive paths in the same render band when their conservative bounds do not intersect, every paint, opacity, fill-rule, cap, join, width, and dash attribute is identical, and concatenating their subpaths preserves appearance and order. A merged `d` attribute is capped at 256 KiB. Non-consecutive paths, intersecting paths, pressure outlines, and paths participating in an animated editor preview are never merged.

The 10,000-stroke fixture, latency targets, memory ceiling, DOM limits, cache requirements, and animation constraints are normative in [Quality, Performance, Animation, and Testing](quality-and-testing.md).

Standalone output, theme classes, external fidelity, and the strict serialized stylesheet are defined in [Standalone SVG Envelope and Theme Rendering](svg-envelope.md).

## Related Documentation

- [Core model](core-model.md)
- [File format](file-format.md)
- [Implementation specification](specification.md)
- [Quality and testing](quality-and-testing.md)
- [Zoom functionality](zoom.md)
- [Feature behavior](features.md)
- [Obsidian integration](obsidian-integration.md)
- [Standalone SVG envelope and theme rendering](svg-envelope.md)
