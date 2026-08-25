# Inkbook Implementation Specification

## Status and Normative Language

This document defines the implementation contract for the Inkbook handwriting embed. `MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative terms.

The focused documents remain authoritative for their domains. This document defines cross-cutting boundaries, state transitions, input precedence, persistence, security, and delivery scope. Conflicts must be resolved by updating all affected documents before implementation continues.

## Product Goal

Inkbook provides a low-latency handwriting editor embedded in Obsidian Markdown notes. It stores a statically renderable SVG together with versioned editable ink data, supports desktop and mobile input, and remains responsive with 10,000 strokes.

The two primary quality goals are:

1. Drawing, selecting, panning, zooming, and editing MUST remain visibly responsive at the 10,000-stroke acceptance dataset.
2. Every user-visible state change MUST animate smoothly unless reduced motion is requested or animation would delay live ink input. Immediate live-input feedback and documented recovery transitions are the only other exceptions.

## Scope

The first release includes:

- locked SVG previews across tabs, panes, and pop-out windows, with one active editor per Obsidian workspace
- pen, highlighter, straight highlighter, eraser, selection, and lasso selection
- lines, arrows, rectangles, ellipses, triangles, octagons, parallelograms, diamonds, coordinate systems, and tables
- stable annotation ordering, line and arrow endpoint snapping with persistent shape connections, styles, backgrounds, page expansion, zoom, clipboard actions, history, duplicate/reference behavior, and pen-tap insertion
- desktop and mobile support without Node.js or Electron runtime APIs
- local-only processing without accounts, network requests, analytics, or telemetry

## Explicit Non-Goals

The first release does not include:

- real-time collaboration or cloud services
- simultaneous active editing in several tabs, windows, or independent Obsidian processes
- OCR, handwriting recognition, or AI features
- editable text inside canvas elements
- arbitrary third-party SVG editing or a public extension API
- alignment guides, named layer panels, arbitrary cross-band ordering, or reusable symbol libraries
- cross-session undo history
- end-to-end or smoke test suites
- a backend, dependency-injection container, event bus framework, or pluggable rendering architecture

## Platform Baseline

- The plugin MUST use TypeScript and the Obsidian plugin API.
- `manifest.json` MUST set `minAppVersion` to `1.13.0` and `isDesktopOnly` to `false`.
- Desktop, iOS, and Android Obsidian MUST be supported.
- Runtime code MUST use Web APIs and Obsidian APIs only. Node.js and Electron APIs are forbidden because they are unavailable on mobile.
- Settings MUST use the declarative settings API available in Obsidian 1.13.
- `npm` and `esbuild` SHOULD be used to match the official sample-plugin workflow and keep the toolchain small.
- `obsidian`, CodeMirror, and Lezer modules MUST remain external to the production bundle. Direct CodeMirror development dependencies are added only when implementation imports require them, use the exact peer versions declared by the selected `obsidian` package, and are updated as one compatibility set rather than through isolated package updates.
- The release artifact contains only `main.js`, `manifest.json`, and `styles.css` when styles are required.

The complete host API, lifecycle, UI, and Community directory contract is defined in [Obsidian Integration](obsidian-integration.md).

## Simple Architecture

The implementation uses five responsibility areas:

| Area          | Responsibility                                                                                                                | May depend on                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `domain`      | Elements, geometry, commands, history, bounds, spatial index, schemas, and pure calculations                                  | Nothing outside `domain`                          |
| `editor`      | Tool state, pointer arbitration, selection, gesture transactions, session state, and autosave scheduling                      | `domain`                                          |
| `rendering`   | React application chrome plus an imperative SVG scene renderer for committed nodes, previews, animation, and viewport culling | `domain`, read-only editor state                  |
| `persistence` | SVG serialization, snapshot validation, migrations, atomic vault writes, clipboard codec, and document worker                 | `domain`, injected Obsidian adapter interfaces    |
| `obsidian`    | Plugin lifecycle, Markdown embed widgets, CodeMirror integration, settings UI, commands, notices, and vault adapters          | All other areas through their public entry points |

### Source Topology and Module Boundaries

The target source topology is:

```text
src/
├── main.ts
├── domain/
│   ├── commands/
│   ├── elements/
│   ├── geometry/
│   ├── schema/
│   └── spatial/
├── editor/
│   ├── input/
│   └── session/
├── rendering/
│   ├── motion/
│   ├── scene/
│   └── ui/
├── persistence/
│   ├── clipboard/
│   ├── documents/
│   ├── saving/
│   └── worker/
└── obsidian/
    ├── inkbook-plugin.ts
    ├── embeds/
    ├── settings/
    ├── styles/
    └── vault/
```

This tree defines ownership, not a requirement to create empty directories. A leaf directory is introduced only when it contains an implementation with that responsibility. `src/main.ts` is the build entry and composition root only; it exports the plugin and MUST NOT accumulate lifecycle, domain, rendering, or persistence logic.

Dependency arrows point inward: `editor`, `rendering`, and `persistence` may import `domain`; `obsidian` performs final composition and may import the other areas through their public entry points. Imports MUST follow the `May depend on` column above. In particular:

- `domain` imports no framework, browser, worker, vault, React, CodeMirror, or Obsidian module.
- `editor` depends only on `domain` contracts and never imports renderer, persistence, React, CodeMirror, or Obsidian implementations.
- `rendering` may consume immutable domain records and narrow read-only editor projections. Framework-free motion contracts, imperative scene code, and React UI code remain in separate leaf folders. Scene and UI communicate through coarse typed state rather than DOM references.
- `persistence` owns codecs, migrations, worker messages, and save orchestration. It receives host I/O through narrow ports and never imports a concrete Obsidian adapter.
- `obsidian` is the outer integration layer and composition owner. It may connect the other areas but MUST NOT reimplement their rules.

Each module has one primary reason to change. Feature-specific types, tests, styles, and helpers stay with their owning area. Generic `utils`, `common`, `shared`, `services`, or `helpers` dumping grounds are forbidden. A shared abstraction is introduced only for a current cross-area contract or verified duplication, receives a domain-specific name, and is placed at the narrowest dependency boundary that can own it without creating a cycle.

Cross-area APIs stay small and explicit. Prefer direct imports from the owning module. Add an area-level `public.ts` only when several external consumers need a stable boundary; do not create recursive barrel files or re-export internal implementation details. Dependency cycles, cross-area mutable globals, hidden singleton access, and framework types in pure contracts are forbidden. The automated source import-graph gate includes TypeScript type-only edges and rejects cycles or imports that violate the responsibility directions above. Naming, coverage, and quality enforcement are defined in [Quality and Testing](quality-and-testing.md#coverage-and-ci-gates).

Tests mirror source ownership. Pure behavior belongs under `test/unit/<area>/`; focused host or worker boundaries belong under `test/integration/<area>/`; reusable external-boundary doubles belong under `test/adapters/<boundary>/`. Tests MUST NOT gain access to internal modules through a broader public API than production code requires.

Additional architecture rules:

- Use one normalized element store and one command history per active document. The persisted `elements` array is a wire representation only. The runtime store owns one private `Map<ElementId, ElementRecord>`, one ordered ID array per fixed render band, and one derived ID-to-rank map.
- Use one `WorkspaceEditorCoordinator` per plugin and `App.workspace`. It serializes session activation across every tab, pane, and pop-out window without owning DOM resources or introducing an event-bus or state-management framework.
- Published element records are immutable. A command replaces only changed records and updates private order, bounds, connection, and spatial-index structures within one transaction. The store publishes one domain-classified delta only after those structures are atomically consistent and assigns monotonic geometry and paint versions at commit. Ordinary commits MUST NOT clone the complete map, either complete band, or an `InkSnapshotV1`; unchanged records retain identity, and the render path performs no record hashing.
- Derive the fixed `highlight` and `content` render bands from element kind and preserve one stable back-to-front order within each band. Reorder commands never cross the band boundary.
- Store line and arrow endpoint connections as semantic target anchors. Maintain one derived reverse map from target ID to connected endpoints so target transforms do not scan the complete store. Linear elements cannot be connection targets, so cycles are impossible.
- Use a small uniform spatial grid index for hit testing, erasing, bounds queries, and viewport culling. The cell size is 256 page units, with the bounded oversized-element rule in [Rendering and Performance](rendering-and-performance.md).
- Use React only for stable application chrome and coarse editor state. Individual ink elements and every pointer, camera, culling, snapping, context-target lookup, or animation-frame update belong to the imperative scene renderer defined in [Rendering and Performance](rendering-and-performance.md).
- Route canvas input through one transparent focusable surface. Committed content and decorative overlays do not participate in browser pointer hit testing, and no individual SVG element owns an event listener.
- Use one document worker per active document. It performs bounded file validation and migration, clipboard codecs, SVG export, hashing, and persisted-output verification. It is an optimization, not a second source of truth, and it never owns DOM, input, scrolling, camera state, the spatial index, or an Obsidian API.
- Bound additional active-plugin memory to 300 MiB on mobile and 1 GiB on desktop. Bounded caches may retain more reusable data only when measured latency improves, and the active memory ceiling always overrides their individual maxima. The complete measurement contract remains normative in [Quality and Testing](quality-and-testing.md#performance-budgets).
- Do not add a state-management library. Plain TypeScript state plus React subscriptions is sufficient.
- Do not add an abstraction unless it removes a current duplication or isolates an Obsidian, worker, clipboard, or vault boundary that must be tested.

## Document and Editor States

Each embed is in exactly one state:

| State        | Input                                                                        | Visible result                                                                                                                                       | Exit                                         |
| ------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `locked`     | Preview activation only                                                      | Static preview with the per-file locked writing buffer                                                                                               | `unlocking`                                  |
| `unlocking`  | Ignored except coordinator cancellation, widget detachment, or plugin unload | Preview remains visible while the editor mounts and measures in place; an icon-only status appears after 1,200 ms even before target height is known | `active`, `locked`, `load-error`, or removed |
| `active`     | Full editor input                                                            | Interactive SVG at derived active height                                                                                                             | `locking`, `save-error`, or `load-error`     |
| `locking`    | Disabled immediately                                                         | Editor animates to width fit and locked height while save completes; an icon-only status appears after 150 ms if persistence is still pending        | `locked` or `save-error`                     |
| `save-error` | Recovery controls only                                                       | Dirty editor remains mounted with Retry, Save local copy, and Cancel                                                                                 | `locking`, `active`, or removed              |
| `load-error` | Recovery controls only                                                       | Last known safe preview with editing disabled                                                                                                        | `unlocking`, `locked`, or removed            |

At most one workspace session, whether attached or detached, may be `unlocking`, `active`, `locking`, or `save-error`. Activating another embed first completes the current lock operation. A failed lock MUST keep the existing editor data in memory and MUST NOT replace the preview with stale content. Retry re-enters `locking`; Save local copy writes and validates a new file, replaces this embed's Markdown target, then locks; Cancel returns to `active` without discarding data. Another embed cannot activate while recovery is unresolved.

The locked presentation and active editor are two states of one lifecycle-owned inline block. Activation preserves its root, top-edge anchor, measured width, attachment, and editor identity; it never inserts an editor before or after the presentation. An empty preview derives at least 2.5 writing lines, rounded up to a complete background step, plus both writable vertical margins. A non-empty patterned preview ends after the occupied pattern row plus exactly one complete pattern row and the writable bottom margin. After stable measurement, the block intentionally animates from serialized `lockedHeight` to the derived `activeHeight` while the preview covers the scene, then completes the preview/editor crossfade. The primary toolbar is one continuous, exactly centered control track painted above the background container through a zero-height sticky overlay; it contributes no block height and may cover already painted Markdown above the embed without moving it. Conditional Copy, Cut, Paste, and Delete controls appear as circular surfaces to its right without changing that center, align to the primary track's top edge, and use the same opaque page surface without a group backdrop. Configured active buffer lines also govern later automatic growth once less than one aligned writable line remains. Commits, autosaves, persisted-resource refreshes, theme changes, and pending document reclassification preserve the active attachment and editor identity. Direct SVG-file editing and a fullscreen editor are outside the plugin scope.

## Workspace Activation and Detachment

One workspace is one plugin instance attached to one `App.workspace`, including all of its tabs, panes, and pop-out windows. Independent Obsidian processes or plugin instances have independent coordinators and rely on the vault conflict rules below rather than an in-memory lock.

Each document session has a unique `sessionId` and a `documentId` equal to its normalized SVG vault path. Each mounted presentation has an opaque `attachmentId` plus an attachment generation. An activation request contains `{ token, documentId, attachmentId, attachmentGeneration }`; the coordinator record retains only these values and a deferred outcome that captures no DOM or host-view object. A request is idempotent only when its attachment ID and generation equal the session's currently attached presentation. The same document in another tab or window is therefore a distinct presentation request, never a second document session.

Every activation request receives a monotonically increasing workspace token. A same-document request with a different current attachment cancels any uncommitted gesture, releases the old presentation resources, and hands the existing store and worker to the new presentation without saving and reloading the document. Any unresolved recovery operation is cancelled before that handoff. A reattached `save-error` session exposes recovery controls but no editable scene until recovery returns it to `active`. A different-document request cancels any uncommitted gesture and starts exactly one lock operation for the current session. The coordinator retains at most one pending activation; a later request replaces that pending request, and the superseded request exits without mounting an editor. A widget unload explicitly cancels its matching pending request and deferred outcome. A clean session still in `unlocking` may be cancelled and released immediately. Otherwise, the pending target may enter `unlocking` only after the exact latest revision of the current session has been written, read-back validated, and released. It MUST recheck that its attachment ID and generation remain registered and its token remains current before creating UI.

Detaching a tab, pane, Live Preview widget, Reading-view child, or pop-out window immediately cancels and reverts its uncommitted gesture and releases its scene, React root, portals, pointer capture, listeners, observers, animation frames, and references to the owning `Document`, `Window`, leaf, and widget. A clean session with no persistence work is then released completely.

A dirty or saving session instead grants the coordinator one bounded detached-save lease. The lease retains only the authoritative store, history required for recovery, document worker, save state, file identity, revision, worker epoch, active save, prepared successor, export generation, and output hashes. It owns no DOM or host-view object, bypasses the autosave debounce, and drains the exact latest revision through the normal conflict and read-back rules. At most one detached lease exists because at most one workspace session is active. Confirmation releases it only when that save revision is still the exact authoritative latest revision. Session token, revision, worker-epoch, active-save, prepared-successor, and export-generation checks prevent late worker or vault results from mutating a released session.

If the same `documentId` remounts before the detached save reaches a terminal outcome, a current-token activation reattaches presentation to the existing `sessionId`, store, and worker instead of loading a second session. It replaces any older pending target under the same latest-request rule. The in-flight save continues; successful confirmation marks the reattached session clean rather than releasing it.

If a detached save fails or conflicts, the coordinator retains one headless `save-error` session and blocks other activations. Reopening the same embed reattaches recovery UI to that session instead of loading a second store. Otherwise, a workspace recovery modal in any surviving Obsidian window offers Retry, Reload external version, and Save local copy. Every recovery operation and result is bound to its basis revision, workspace token, session and worker epoch, plus the current attachment identity when attached. A mismatch cannot release or dispose the session. Reload discards dirty local state only after explicit confirmation. Save local copy validates a new SVG and reports its vault path; it does not silently rewrite a closed note. If that recovery operation becomes stale, is cancelled, or fails after creating the candidate file, Inkbook attempts recoverable cleanup through `FileManager.trashFile()` and never confirms the copy. Cleanup failure remains a failed recovery and may leave an explicitly unverified artifact for manual cleanup. Closing the modal leaves recovery pending and preserves the in-memory session.

Plugin disable or host-process termination cannot guarantee completion of asynchronous persistence because `onunload()` is not awaitable. The plugin registers best-effort quit work where supported, never reports an unconfirmed save as successful, and keeps the normal 500-millisecond autosave as the primary risk reduction. This limitation does not permit ordinary tab, pane, or pop-out detachment to discard dirty state.

## Input Arbitration

Input precedence is evaluated in this order:

1. While a normal pen pointer is active, touch pointers are ignored as palm input.
2. A pen eraser tip or configured pen side button temporarily activates Eraser and restores the previous tool on release or cancellation.
3. Holding `Ctrl` or `Cmd` at pointer down temporarily activates Eraser for mouse or normal-pen input and restores the previous tool on release or cancellation, except when the event is a platform context click such as macOS Control-click. Context-click classification wins before temporary-tool arbitration.
4. Two touch pointers activate pinch zoom. A pending one-finger action that has not committed is cancelled.
5. A normal pen pointer uses the active tool. Draw is the initial active tool.
6. A single touch beginning on an element selects that element regardless of the active tool and starts the bounded context-menu timer. Movement beyond 6 screen pixels cancels that timer and moves the selection. A second touch cancels the timer and uncommitted move, then starts pinch zoom.
7. A single touch beginning on empty canvas uses the active tool only when the device-and-vault finger-drawing setting and the embed toolbar toggle are both enabled. Otherwise the editor owns the gesture and routes it deterministically to vertical note scrolling, horizontal page panning while zoomed, or a context-menu long press.
8. Only a primary mouse button that is not classified as a platform context click may enter active-tool arbitration. Its allowed modifiers are then interpreted by the temporary-Eraser and Shift-selection rules. A secondary-button press or platform context click, including macOS Control-click, is reserved for the native context menu and MUST NOT capture the pointer, start a tool or move preview, mutate selection before target resolution, create history, or dirty the file. Other mouse buttons cause no canvas mutation. An eligible primary-button element click selects only while Select is active, and an eligible primary-button drag from empty canvas while Select is active performs lasso selection.

Lasso is an interaction of Select, not a separate toolbar tool. Touch input that starts on an element selects instead of drawing or erasing that element. This explicit priority prevents one gesture from producing multiple actions.

All pointer gestures MUST:

- acquire pointer capture after winning arbitration
- handle `pointercancel` and lost capture by reverting uncommitted previews
- commit at most one history transaction
- ignore non-finite coordinates or pressure values
- release capture, temporary tools, timers, and animation-frame callbacks on every exit path

One dispatched event may contribute at most 4,096 coalesced samples. Before any sample reaches a gesture, the complete batch is validated atomically for the winning pointer ID and type, finite monotonically nondecreasing timestamps, page coordinates within `-1,000,000..1,000,000`, and pressure within `0..1`. An invalid or oversized batch cancels the current gesture and restores its preview without accepting an earlier prefix, throwing through the host callback, or creating history.

The active canvas uses `touch-action: none`; Inkbook, rather than the browser gesture recognizer, owns touch pointers inside it. The input reducer uses these states:

| State            | Entry                                                                                                                                               | Transition or commit                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`           | No active pointer                                                                                                                                   | Pointer down enters one state below and captures the pointer immediately                                                                  |
| `touch-pending`  | One touch on empty canvas with finger drawing off                                                                                                   | Start a 500 ms timer and remain pending while total movement is at most 10 pixels                                                         |
| `note-scroll`    | From pending only after movement exceeds 10 pixels and vertical movement is dominant, or any direction exceeds 10 pixels at fit zoom                | Apply movement to the nearest pane scroller; dominant means `abs(dy) > 1.25 * abs(dx)`                                                    |
| `page-pan`       | From pending only after movement exceeds 10 pixels, horizontal movement is dominant, and zoom is above fit                                          | Apply horizontal movement to `camera.x`; dominant means `abs(dx) >= 1.25 * abs(dy)`                                                       |
| `element-move`   | Touch begins on an element regardless of tool, or mouse/pen begins on an element while Select is active                                             | Select immediately; a stationary 500 ms touch opens the native menu, while movement beyond 6 pixels cancels its timer and previews a move |
| `lasso`          | Mouse, pen, or enabled-finger drag begins on empty canvas while Select is active                                                                    | Preview one lasso transaction after movement exceeds 6 pixels                                                                             |
| `eraser-gesture` | Pen or mouse begins with Eraser active, or enabled-finger input begins on empty canvas with Eraser active                                           | Preview candidate opacity only; commit one removal command on release                                                                     |
| `tool-gesture`   | Pen or mouse begins with Draw, either highlighter, or a shape active, or enabled-finger input begins on empty canvas with one of those tools active | Preview one creation transaction                                                                                                          |
| `pinch`          | Second touch arrives                                                                                                                                | Cancel pending long press, element move, or tool preview; capture both touches and zoom from their midpoint                               |

If movement exceeds 10 pixels without a dominant axis, `touch-pending` chooses note scrolling. Horizontal movement at fit zoom also chooses note scrolling and never enters a dead state. A long press opens the native context menu only when its timer fires with no second touch, no winning gesture, and movement no greater than 6 pixels from an annotation start or 10 pixels from an empty-canvas start. Before `Menu.showAtPosition()`, the reducer cancels its timer and any zero-distance preview, releases pointer capture, marks the still-down pointer as consumed until its eventual release or cancellation, and returns to `idle`. That later pointer event cannot start or finish a gesture. This exit creates no history entry and does not dirty the file. Pointer cancellation restores the pre-gesture camera, scroll, selection geometry, and model state.

Eraser candidates remain present in the model while their preview opacity fades. A sweep retains one materialized candidate window and at most 512 pending path segments. Each update performs at most 12,288 exact-intersection work units and stops at the current 8-millisecond deadline; unfinished work resumes without duplicating candidates. Pointer-up drains the remaining work in cancellable slices, prepares one atomic store mutation, and registers exactly one history command. Queue overflow, invalid input, cancellation, detachment, or stale generation rejects the entire sweep, restores full opacity, and removes nothing.

Obsidian remains the sole vertical scroll owner. As soon as a Reading-view or Live Preview integration has safely recognized an Inkbook presentation and before Inkbook performs a width-derived preview or editor measurement, its adapter resolves the host scroller through the public, selector-free ancestor rule in [Zoom Functionality](zoom.md#anchored-zoom), acquires a presentation-lifetime scrollbar-stability lease on that element, and reserves the native gutter. The lease remains across lock and unlock and is never acquired, released, or restyled by `pointerdown`, pointer movement, or pointer release. The canvas creates no nested vertical scroller, never overlaps the resolved native scrollbar gutter, and never routes scroll, pointer, layout, or camera work through React or the document worker. Exact host-style ownership and platform limits are defined in [Obsidian Integration](obsidian-integration.md#native-scroll-owner-and-scrollbar-stability).

## Hit Testing and Selection

- Hit tolerances are measured in screen pixels and converted to page units by dividing by the current zoom.
- Mouse and pen use an 8-pixel tolerance. Touch uses a 14-pixel tolerance.
- Candidate lookup MUST use the spatial index rather than scanning every element.
- Candidates are tested front to back within their render band. Snap ties use the same rank before stable ID and anchor ordering.
- Transparent closed-shape interiors do not count as hits unless the shape has a non-zero fill opacity.
- Coordinate systems and tables are atomic selectable elements. Any visible subline selects the entire element.
- Lasso selection uses intersection, not full containment. Holding Shift unions the result with the existing selection.
- Tapping or clicking empty canvas with Select clears the selection.
- Switching away from Select keeps the selection visible until a creation gesture starts, the user presses Escape, locks the embed, or selects another element.

## History Transactions

- A completed draw, erase sweep, transform, shape edit, style change, layer reorder, paste, cut, delete, or erase-all action is one command.
- Endpoint attachment or detachment is part of the creation or endpoint-edit command. Reorientation caused by a target transform and detachment caused by target removal are part of the target command.
- Pointer previews are not history entries.
- Cancelled and no-op gestures create no history entry.
- A new committed command clears redo history.
- Cut removes elements only after the system clipboard write or documented in-session fallback succeeds and a final check confirms the same session, worker epoch, clipboard operation, basis revision, exact selection, and selected record versions. A stale Cut keeps the copied payload but removes nothing and creates no history entry.
- Automatic page-height, camera, focus, hover, and animation changes never enter history.
- The default history limit is 200 commands or 64 MiB of retained command payloads, whichever is reached first. Oldest commands are discarded first.

## Persistence and Concurrency

- The validated editable snapshot is the source of truth. The visible SVG paths are derived output.
- Every save writes one complete SVG file containing one matching snapshot revision. “Incremental save” means incremental worker computation, never a partial file write.
- Completed unlock validation produces one revision-bound per-element derivation bundle containing bounds and spatial-capacity facts. Worker model initialization and main-thread Store hydration reuse that bundle after boundary consistency checks instead of recalculating geometry. Incremental saves carry matching Store derivations for changed records through coalescing. The worker validates each changed element, calculates its conservative bounds once, and accepts a supplied derivation only when its ID, bounds, and spatial-capacity facts match; a missing derivation falls back safely, while a stale or inconsistent derivation rejects the delta atomically. Accepted bounds are reused by aggregate validation, page extent, fragment construction, and export. Page changes use isolated page-schema validation, and connection-affecting changes validate aggregate limits and complete semantic relations over the already validated worker model without a full unchanged-geometry rescan.
- Runtime instrumentation records unlock parsing and validation, runtime copy, batch and Store adoption, parser finalization, worker-model adoption, worker delta update, serialization, and total elapsed durations as separate phases. These measurements are diagnostic and benchmark inputs, not persisted file data.
- Each document revision is a monotonically increasing safe integer, incremented exactly once per committed persisted-state change, including Undo and Redo. Worker model revision, export state, gap recovery, acknowledgement, identity, and dirty-clearing rules are normative in [Rendering and Performance](rendering-and-performance.md).
- Worker identity is purpose-specific: `workerEpoch` identifies an executor, `exportGeneration` orders only replaceable SVG export results, one admitted `activeSaveOperation` remains non-replaceable through read-back, and unlock plus clipboard jobs use their own operation IDs. A newer export may replace only `preparedSuccessor`, never an active save. An unrelated worker request and a queued timer invalidate neither.
- Existing SVG saves MUST use worker-validated uncached `Vault.read()` preflight followed by `Vault.process()` with a synchronous exact-base and current-editor-revision check. New SVG files use `Vault.create()`. Direct `Vault.adapter` and `FileSystemAdapter` access are forbidden.
- Each persistence read checks the public `TFile` identity and `{ path, ctime, mtime, size }` before and after the full host read, serializes reads and writes per normalized path, and rejects changed or oversized bytes. Obsidian exposes no public bounded, ranged, streaming, or abortable Vault read, so a raced external growth may be transiently materialized by the host before postflight rejection. Inkbook neither accepts those bytes nor bypasses the public mobile-compatible API to claim a hard pre-materialization limit.
- A failed write leaves the document dirty, retains the last valid file, reports a retryable notice, and retries on the next save trigger or explicit Lock.
- After an indeterminate write outcome, suspend autosave until the file is read through `Vault` and classified. If the executor failed after writing began, a new-epoch `verificationOperationId` remains bound to the immutable old `{ saveOperationId, revision, outputHash }` proof. If the file contains that revision and its validated bytes match the proof, confirm it and advance the vault base without writing again. If it still matches the previously confirmed base, retry is permitted. Any other result is an external conflict. Dirty state never clears from a write promise alone, and confirmation of an older revision never clears a newer dirty revision or releases its detached-save lease.
- Lock and coordinator-driven different-document replacement MUST await the current session's pending save and read-back confirmation. Widget detachment during this operation transfers dirty or saving persistence work to the coordinator's detached-save lease instead of cancelling it. Only plugin unload invalidates the session identity, worker epoch, purpose-specific operations, and unfinished work; it cannot guarantee completion of asynchronous persistence. Managed renames use `FileManager.renameFile()`.
- If an external modification arrives while the document is clean, reload it. If it arrives while dirty, suspend autosave and offer `Reload external version` or `Save local copy`. Never overwrite silently.
- Other embeds referencing the same file remain locked and refresh their preview after a successful save.
- Separate Obsidian processes never share the workspace coordinator. Their saves use the same exact-base preflight, revision, save-operation, export-generation, and read-back rules, so concurrent edits produce an external conflict rather than a silent overwrite.

## File Creation and References

- New files resolve [File Placement](settings.md#file-placement): `obsidian-attachment-folder` uses `FileManager.getAvailablePathForAttachment()`, `note-folder` uses the current note folder, and `custom-vault-folder` uses a validated path normalized by `normalizePath()`. Any unavailable or invalid destination falls back to the note folder and shows a notice.
- Names use `inkbook-YYYYMMDD-HHmmss-<six-lowercase-hex>.svg` and retry with a new suffix on collision.
- Markdown embed text prefixes `!inkbook` to the complete result of `FileManager.generateMarkdownLink(file, sourcePath)` for the created SVG. This produces `!inkbook[[path.svg]]` or `!inkbook[label](path.svg)`, neither of which is native image syntax. Empty alias or subpath arguments MUST NOT be supplied because the host's preferred link format owns the link delimiters.
- Duplicate creates and validates the new file before replacing the pasted Markdown path.
- Reference lookup uses `MetadataCache.getFirstLinkpathDest()` and `MetadataCache.resolvedLinks` after metadata resolution. It never scans or reparses every Markdown file.
- Recoverable deletion uses `FileManager.trashFile()` and never `Vault.delete()`.
- An uncertain reference scan, failed write, failed Markdown edit, or failed trash operation MUST preserve the SVG and show a notice.

## Security and Privacy

- The plugin is local-only and MUST make no network requests.
- Analytics, telemetry, tracking, remote error reporting, and content logging are forbidden.
- SVG files, embedded snapshots, clipboard payloads, Markdown paths, vault events, and worker messages are untrusted input.
- Preflight total bytes through `TFile.stat.size`, transfer the `Vault.readBinary()` result, and perform full UTF-8, XML allowlist, metadata, JSON, schema, depth, count, and byte-limit validation in the document worker during normal unlock. After the worker has validated the bounded metadata structure, schema, migration, root version, revision, and derived locked height, it MAY transfer bounded hydration batches into a detached main-thread builder while static-integrity validation continues. Those staged domain arrays and index entries are not published, rendered, cached as paths, or exposed to input, and every failure, cancellation, stale identity, or terminal-count mismatch releases them. Only the terminal successful validation result may publish the completed store and enable interaction.
- Interactive editing MUST regenerate SVG elements from validated domain data and MUST NOT inject source SVG markup with `innerHTML`. The locked, non-interactive presentation is the sole exception: after complete strict safe-envelope validation, it may parse the allowlisted source with the owning window's `DOMParser`, discard metadata and the embedded stylesheet, import the remaining SVG presentation nodes, and apply only Inkbook's scoped canonical theme rules.
- Generated SVG output is allowlisted to required structural and drawing elements and attributes. Scripts, event attributes, foreign objects, external URLs, remote fonts, and executable content are forbidden.
- Obsidian renders the custom `!inkbook` source as non-image text and a link before Reading-view postprocessing. After exact standalone-section and resolved-document correlation, Inkbook incrementally validates the complete strict SVG allowlist before replacing the section with its owned locked-preview surface. It removes snapshot metadata and the standalone stylesheet before importing the remaining inert presentation SVG, then uses scoped canonical host rules for light/dark paint and one-screen-pixel guides. Unsafe, unsupported, stale-during-validation, or oversized input is never inserted and leaves the non-image custom link unchanged. Editable domain publication still requires the document worker's complete semantic, integrity, migration, and limit validation.
- Paths MUST resolve inside the vault. Absolute paths and traversal segments are rejected.
- Enforced limits are defined in [File Format](file-format.md) and [Quality and Testing](quality-and-testing.md).
- Errors and logs may include operation names and internal error codes, but never stroke contents, clipboard contents, note text, or full vault paths.

## Failure Defaults

When behavior is uncertain, preserve data and deny the destructive action.

- Invalid or unsupported snapshots open as a static preview with editing disabled.
- A corrupt editable snapshot never causes the original SVG to be rewritten automatically.
- Worker construction or runtime failure invalidates the worker epoch and switches once to the same pure algorithms in bounded, input-aware main-thread slices under a new epoch for the remainder of the session. Unwritten operations restart with new purpose-specific IDs. Once a write begins, the immutable active-save proof survives epoch invalidation and only a new verification operation may classify it; the write is never repeated before classification. The fallback covers unlock validation and migration, clipboard codecs, SVG export, hashing, and persisted-output verification; repeated failures are reported without retry loops.
- Preview failure keeps the editor mounted when safe and offers retry.
- Clipboard failure leaves the canvas unchanged unless the in-session fallback contains a validated payload.
- Delete and undo-insert failures preserve recoverable files and report the exact incomplete operation.
- Session and autosave disposal are terminal and idempotent. Late exports, verifications, executor failures, fallback construction, and successor work perform no state adoption or new Vault I/O after disposal; already started host writes remain non-abortable and are classified only by their retained immutable proof.

## Implementation Order

1. Implement schemas, validation, geometry, bounds, page extent, commands, and history as pure TypeScript.
2. Implement SVG rendering and round-trip serialization for all elements.
3. Implement the editor store, spatial index, input reducer, and direct live previews.
4. Implement the public Obsidian surfaces, vault persistence, settings, clipboard, and Editor-backed Markdown insertion defined in [Obsidian Integration](obsidian-integration.md).
5. Implement animation, accessibility, document-worker tasks, culling, caches, and performance tuning.
6. Complete the unit and integration acceptance matrix before release.

## Related Documentation

- [Core model](core-model.md)
- [File format](file-format.md)
- [Editor tools](editor-tools.md)
- [Embed UI](embed-ui.md)
- [Features](features.md)
- [Rendering and performance](rendering-and-performance.md)
- [Settings](settings.md)
- [Quality and testing](quality-and-testing.md)
- [Obsidian integration](obsidian-integration.md)
