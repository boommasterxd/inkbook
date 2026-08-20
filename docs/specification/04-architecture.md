# Architecture

## 1. Architectural Goals

The implementation MUST keep the annotation domain independent of Obsidian, CodeMirror, SVG DOM, storage, and UI frameworks. Obsidian integration is an adapter around a deterministic domain and application core.

The architecture MUST optimize for:

- one canonical annotation session per note;
- many independent view adapters for split panes;
- bounded work proportional to visible or changed content;
- no global mutable scene state;
- explicit lifecycle and cleanup;
- immutable public snapshots and reversible operations;
- narrow, testable interfaces.

## 2. Package Topology

```text
src/
  domain/
    scene/
    anchors/
    operations/
    geometry/
  application/
    note-session/
    commands/
    persistence/
    recovery/
  rendering/
    svg/
    spatial-index/
  input/
    pointer-routing/
    gestures/
  ui/
    toolbar/
    stylebar/
    status/
  adapters/
    obsidian/
      editor-overlay/
      reading-overlay/
      vault-sidecar/
      recovery-indexed-db/
      settings/
      commands/
  workers/
    scheduler/
    geometry/
    persistence/
    bulk-operations/
```

Dependencies MUST point toward `domain/`. Domain code MUST NOT import Obsidian, CodeMirror, React, browser DOM, or storage APIs. Application code MAY depend on domain ports. Adapters and UI implement those ports. Cyclic dependencies are forbidden and MUST be checked in CI.

## 3. Core Responsibilities

### 3.1 Domain

The domain owns the closed scene and codec contracts in [Domain Model and Codecs](15-domain-model-and-codecs.md), the binding contracts in [Anchors and Layout](05-anchors-and-layout.md), and the operation algebra in [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). One pure selection-model service derives `linear`, `area`, `axis-set`, or `aggregate` control geometry from immutable canonical records; UI and rendering adapters MUST NOT duplicate element-kind rules. Binding inference consumes immutable element geometry and immutable layout evidence supplied through a domain port. It MUST NOT inspect browser DOM, import Obsidian or CodeMirror types, or depend on a separate drawing-tool mode. Invalid states SHOULD be structurally unrepresentable.

### 3.2 Application

The application layer owns command admission, operation publication, host-effect envelopes, recovery attempts, shared note sessions, save generations, conflict state, and derived-state scheduling. Its closed states, errors, and transitions are defined in [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). Obsidian's existing editor history owns the user-visible undo and redo order in each supported editable pane; the application validates and applies the annotation effects carried by that order. One command produces at most one canonical publication. A note session serializes commands through one non-reentrant queue; listener callbacks and view updates cannot synchronously re-enter publication and are queued or coalesced instead. Geometry transforms and style changes are distinct operation variants. A resize operation cannot carry a style-width mutation, and a line-width change cannot masquerade as geometry resize.

### 3.3 Rendering

The renderer consumes immutable scene and layout snapshots. It owns SVG nodes, viewport culling, path and paint-bounds caches, selection chrome, and hit-test acceleration. It MUST NOT mutate the canonical scene. Selection control bounds are derived from canonical geometry rather than DOM `getBBox()` reads during a gesture.

### 3.4 Input

Input adapters convert pointer, touch, stylus, keyboard, and context-menu events into application commands. Preview state remains transient and is never persisted as a half-finished operation.

Each view adapter owns one bounded secondary-button recognizer with only `idle`, `menu-pending`, and `pan-active` states. It freezes the initial hit classification, applies the screen-space slop from [Interaction and Tools](02-interaction-and-tools.md), and claims events only after the pan or plugin-menu outcome is known. Right-button pan is view presentation and MUST NOT enter the domain command, recovery, history, or sidecar pipelines.

### 3.5 Obsidian Adapters

Obsidian adapters own EditorView discovery, MarkdownView lifecycle, Vault file access, rename and delete events, commands, settings, and reading-mode post-processing. They MUST not leak host types into the domain. They implement the concrete version, view, editor, lifecycle, Vault, Android, and packaging boundaries in [Obsidian Host Contract](14-obsidian-host-contract.md).

### 3.6 UI

React is limited to toolbar, stylebar, settings, menus, and status surfaces. It does not own the annotation scene, SVG element lifecycle, pointer samples, gesture preview, scrolling, zoom transforms, culling, or selection chrome. UI components subscribe through narrow immutable selectors and stable callbacks. A scene change that does not affect the selected UI slice MUST NOT rerender that component. Per-element React components and one application-wide provider whose value changes for every scene revision are forbidden.

Each supported Markdown view owns one retained toolbar host and its external visibility toggle. Collapsing changes one view-local selector and hides only the toolbar and stylebar subtrees; it does not recreate the framework root, resubscribe the scene, rebuild tool controls, remount the annotation overlay, or publish application or canonical state. Expanding restores the retained UI state. Disposal still removes the complete host and every subscription exactly once with the owning view.

### 3.7 Worker Scheduler

One plugin-owned bounded scheduler routes CPU-intensive DOM-independent work to shared workers. It owns priority, cancellation, revision tokens, transferable buffers, backpressure, failure recovery, and disposal. No view, annotation, gesture, or request creates an unbounded dedicated worker. V1 worker source is a build-time static payload inside `main.js` and is launched through one Phase-0-proven desktop and Android adapter using only a permitted local URL or Blob mechanism. No additional release artifact is assumed. Generated worker code is immutable and release-audited; remote worker code, `eval`, and dynamic untrusted code generation are forbidden. The adapter revokes temporary URLs and releases workers, ports, listeners, and buffers during disposal. Host API calls, DOM reads and writes, input arbitration, and the final already-validated immutable publication remain on the main thread.

## 4. Plugin Lifecycle

The default plugin export MUST extend Obsidian `Plugin`. Its asynchronous `onload()` first loads and validates settings, then performs only lightweight registrations: commands, one editor extension definition, Markdown post-processing, the settings tab, and owned host events. Vault scans, sidecar parsing, recovery probing, worker creation, whole-view measurement, and scene construction are forbidden during `onload()`.

Layout-dependent initialization and Vault `create` observation begin through `workspace.onLayoutReady()` or a lazy open-note boundary. Because `onLayoutReady()` has no disposer, its callback captures a plugin lifecycle token and checks it before every side effect, resource registration, and asynchronous continuation. `onunload()` invalidates that token before disposing children. Work that arrives before layout readiness returns without expensive processing. Every resource owner MUST be an Obsidian `Component` or be attached to one through `addChild()`, expose idempotent disposal, and release children before its own state. Host events use `registerEvent()`, DOM events use `registerDomEvent()`, and intervals use `registerInterval()`. Disposal MUST remove DOM nodes, event listeners, pointer capture, observers, animation frames, timeouts, intervals, subscriptions, framework roots, workers, message ports, caches, and note-session references.

The plugin MUST NOT access Node.js `fs`, `path`, Electron, or hard-coded Vault configuration paths. It MUST use Obsidian Vault APIs for note and sidecar operations and platform detection APIs for capability differences.

Production code MUST NOT use global `app`, `window.app`, global mutable plugin state, or global `document` and `window` for view-owned resources. Adapters receive the plugin or `App` explicitly. A view uses the concrete root's Obsidian `element.doc` and `element.win` helpers, including after `onWindowMigrated()` fires for a desktop pop-out window.

CodeMirror is Obsidian's native Markdown editor engine and an Obsidian-owned integration surface. Inkbook neither creates nor replaces the Markdown editor and does not own authored text, native selection, text transactions, key bindings, or editor history. Communication with that host surface MUST use one registered editor extension, typed `StateEffect` messages, and a per-editor `ViewPlugin` only for bounded viewport integration, revision observation, and the release-gated history bridge. If the selected Obsidian version still requires access through an untyped host property such as `editor.cm`, exactly one Obsidian adapter may contain one narrowly scoped `@ts-expect-error` after runtime shape validation. `any` and `@ts-ignore` are forbidden at that boundary. A compatibility contract test MUST exercise the typed available and unavailable results for every supported Obsidian version. No domain, application, rendering, input, or UI code may use the exception.

## 5. Note Sessions and Multiple Views

`NoteSessionRegistry` owns at most one `NoteSession` for each resolved Markdown file identity. Its public state is exactly `NoteSessionSnapshotV1` from [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). A session contains:

- the validated canonical annotation scene;
- annotation revision and sidecar revision;
- bounded immutable forward and inverse annotation records referenced by host-history effects;
- pending save generation and conflict status;
- monotonic Markdown source-checkpoint generation and durable checkpoint status;
- text-binding source snapshots and deterministic boundary reattachment results;
- shared derived geometry that is independent of a particular viewport.

Each native Live Preview, Source, or Reading View owns a separate `ViewOverlayAdapter`, keyed by its concrete workspace leaf and host view instance, with:

- the current host layout token;
- visible ranges and viewport bounds;
- note-to-screen transform and current zoom;
- SVG DOM and view-local caches;
- selection, hover, open menu, secondary-button recognizer, pan state, and transient gesture preview.

View-local state MUST NOT overwrite another pane's viewport or selection. One concrete editable view holds the note session's annotation-history lease for one monotonic epoch. The first otherwise valid annotation mutation acquires it; focus, selection, Markdown typing, scrolling, and toolbar use do not. Only that view may originate annotation mutations; every attached view receives each canonical publication in one total session order. Non-owner panes remain current read-only annotation projections and retain native Markdown editing. The lease does not transfer while the owner and its actionable annotation effects remain alive. Owner disposal first settles or blocks pending history intents, recovery-protects the exact scene, and closes the epoch before another concrete editor may acquire a new one. Leaf detach, host-view replacement, file or mode change, pop-out migration, and plugin unload fully dispose the affected adapter before a fresh adapter binds to any replacement identity or owner window. Rebinding never reuses listeners, observers, framework roots, DOM, timers, projection tokens, or session references from the prior adapter. Linked groups do not share view-local state.

Zoom-independent canonical paths, pressure outlines, source-range bindings, and text-boundary reattachment results are shared by `NoteSession`. Layout-dependent line fragments, enclosing-region bounds, background rhythm regions, DOM nodes, screen transforms, visible candidate sets, and selection chrome remain per view because two panes may wrap the same Markdown differently. Sessions are reference-counted. Passive workspace discovery checks `WorkspaceLeaf.isDeferred` and skips a deferred leaf without calling `loadIfDeferred()` or `revealLeaf()`. Production code MUST NOT import or use `instanceof` against a non-public `DeferredView` class. Only an explicit user command may await `workspace.revealLeaf()`, then recheck the concrete view and file identity. Direct `loadIfDeferred()` is a measured compatibility fallback, not a passive-discovery tool.

View resources detach synchronously without waiting for Vault I/O. When the last view detaches while the plugin remains loaded, the headless session MUST retain every transient or active source checkpoint until it is recovery-protected or the two-second flush bound expires. A successful bounded flush preserves exact reopen behavior. A timeout enters the documented source-checkpoint failure path and retains only acknowledged recovery plus the bounded evidence required for external reattachment. The scene, history, and caches are released only after that decision. On plugin unload, only acknowledged recovery entries are durable. Active work is cancelled after its current bounded slice, no synchronous unload wait is implied, and an unprotected source generation may require bounded external reattachment. A save failure or conflict never removes acknowledged recovery.

### 5.1 Bounded Resource Ownership

Each subsystem owns explicit numeric limits for the resources it retains, including sessions, views, queues, buffers, caches, listeners, timers, workers, recovery records, and persistence work. Admission checks the applicable local count and byte limits before retaining a payload or starting work. Transfers keep one clear owner, and every terminal success, failure, cancellation, replacement, or disposal releases that ownership exactly once. A plugin-wide accounting framework is not required unless measured cross-subsystem pressure demonstrates that local limits cannot enforce the release budgets.

When a limit is reached, Inkbook preserves native Markdown and acknowledged recovery, coalesces only replaceable work, evicts only disposable least-recently-used caches, and otherwise rejects the new annotation operation or suspends the affected inactive projection with truthful resource-limited status. It MUST NOT evict actionable history, active gestures, unacknowledged recovery, current owner leases, or dirty save bases. Reactivation requires current identity validation and available local capacity.

## 6. Editor Integration

Inkbook registers its narrow adapter extension once into Obsidian's existing editor configuration. It MUST NOT create an `EditorView`, register another CodeMirror `history()` extension, or replace the host keymap. Each concrete Obsidian-owned `EditorView` creates one bounded `ViewPlugin` value and destroys it with that view. Work derived from visible ranges MUST use the post-transaction viewport and be limited to the current viewport plus a versioned bounded overscan region. Updates coalesce to at most one projection request per animation frame. The implementation MUST not rely on DOM nodes for text that CodeMirror has not mounted or force offscreen content to mount.

The plugin MAY use editor decorations only for viewport-neutral lightweight anchor markers or layout probes. Decorations MUST NOT replace or hide Markdown, add line breaks, alter vertical layout, or retain annotation scene state. A state field contains only a small immutable marker set, applies typed effects in transaction order, and performs no DOM work, note-session mutation, application dispatch, or unbounded computation in `create()` or `update()`.

External projection messages include view identity plus editor, layout, and scene revisions and enter through `EditorView.dispatch()` as typed effects. Stale messages are ignored; external code MUST NOT mutate state-field or view-plugin values directly. Native Markdown mutations use Obsidian `Editor` or one intentional CodeMirror transaction and remain native host-history events. YAML marker updates follow the `processFrontMatter()` contract in [Sidecar Persistence](07-sidecar-persistence.md) outside host history.

For a supported editable CM6 view, the history bridge contributes one isolated invertible annotation effect to that concrete editor's existing history. The effect changes no Markdown and carries a bounded immutable handle to one stable `HistoryEntryId` whose revision-free forward and inverse patches remain available while the effect is actionable. `invertedEffects` or the selected equivalent produces only the opposite direction of that history entry. `isolateHistory` or the selected equivalent prevents text typed before and after an annotation operation from merging across it. The `ViewPlugin` forwards ordered effect intents to the shared `NoteSession`; state fields remain pure and contain no canonical scene. The session remains authoritative for validation, recovery, scene publication, and sidecar persistence. An effect created in one pane is not duplicated into another pane's history, while a successful operation updates every attached projection.

The actionable host-effect envelope, delivery, and lifecycle use exactly `HostEffectEnvelopeV1`, `HostEffectDeliveryV1`, and `HostEffectLifecycleV1` from [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). The original forward effect records initial admission only while `admitting` and means Redo only while `undone`; the inverse effect means Undo only while `applied`. Every transition validates note identity, history epoch, history-entry identity, monotonic host transaction sequence, current owner, current lifecycle, and current scene before creating a fresh revision-bound dispatch. An equal accepted sequence is an idempotent retry, a lower sequence is stale, and only a greater lifecycle-valid sequence advances. Initial admission MUST NOT apply the forward patch twice. An event from a non-owner pane, closed epoch, unexpected direction, or stale lifecycle fails closed without canonical mutation.

Recovery attempts are the separate short-lived records and transitions defined in [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md). Every Forward, Undo, or Redo direction uses a distinct monotonic `RecoveryAttemptId` linked to the stable history entry, fresh dispatch ID, history epoch, effect identity, direction, expected current scene revision, expected durable source generation and digest, and sidecar base. Sidecar acknowledgement removes only the completed direction attempt, never the actionable host-effect envelope, history entry, or in-memory lifecycle.

The complete host-history bridge is a Phase 0 release gate. It MUST prove ordering, branching, operation lifecycle, bounded payload retention, asynchronous recovery failure behavior, owner-pane leasing, disposal, and Android support against the actual production bundle and host versions. If the bridge is absent, stale, malformed, unsupported, or cannot preserve recovery ordering, annotation mutation in that editable mode fails closed with truthful status. Inkbook MUST NOT fall back to a competing `Mod+Z` stack. Reading View remains presentation-only.

All commands that act on an editor MUST use `editorCallback` or `editorCheckCallback` and the supplied actual `Editor` and `MarkdownView`. Conditional checking is repeated on both invocations; the `checking: true` path is side-effect-free. Commands MUST NOT assume that the globally active view is the gesture source.

## 7. Reading View Integration

Reading-mode integration MUST use registered Markdown post-processing and scoped observers. Each postprocessor invocation reads only its rendered section and reports only that section's geometry to one coordinator owned by the concrete Reading View. Rendered DOM order is not source-range authority or lifecycle authority. Source mapping comes from documented processor context and validated bounded evidence. A callback MUST NOT create a whole-note overlay independently. The coordinator deduplicates reports by document identity, source path, preview instance, and section generation.

Every section-bound observer or resource MUST be owned by a `MarkdownRenderChild` registered through `MarkdownPostProcessorContext.addChild()`. The whole-note overlay host has one explicit owner per Reading View and is disposed with that view. It MUST never append duplicate overlays when a section is reprocessed. Active children, observers, section reports, and generation records use explicit per-view limits; an over-limit section remains native and unannotated until a prior generation disposes or a bounded retry succeeds.

The plugin registers no Markdown code-block processor and never replaces authored rendered content. The exact callback granularity, source evidence, reprocessing behavior, child teardown, stable host attachment points, whole-note zoom, and overlay geometry MUST be proven with desktop and Android prototypes before the rendering milestone exits. Reading View is read-only for annotation editing in V1. Unsupported DOM assumptions MUST fail closed by disabling the overlay or showing a non-destructive status, not by writing guessed coordinates.

## 8. Layout Coordination

Each view owns one `LayoutCoordinator`. It coalesces editor transactions, resize observations, mutation observations, theme changes, font changes, scroll, and zoom invalidations into revision-bound work.

Within one animation frame, the coordinator batches all DOM reads before any DOM writes. Repeated per-element `getBoundingClientRect()` calls during active input are forbidden. Source ranges, block measurements, matrices, and computed typography are cached by layout token. Pure computation over captured layout evidence is worker-first; only bounded measurement and final projection writes remain on the main thread. The existing test or benchmark that owns a path records the available style-recalculation, forced-layout, DOM-read, DOM-write, worker-transfer, React-commit, and component-render counts. This requirement does not mandate one shared performance harness.

A change in available note width increments the host-layout revision and may rewrap Markdown. The coordinator derives new text-range fragments, text-position transforms, enclosing regions, background rhythm regions, affected bounds, and spatial-index updates against one immutable layout snapshot. It publishes the complete view-local projection atomically only if that snapshot is still current. Stale work is discarded, and it MUST NOT mutate the canonical scene, append history, or enqueue a sidecar save.

Pure note zoom uses the existing shared presentation transform whenever logical note width is unchanged. It updates view and hit-test matrices without text reclassification or sidecar work. If the host changes logical width while zooming, the resulting width change follows the normal host-layout revision path rather than applying an independent SVG scale.

## 9. Publication Order

A successful annotation command MUST publish atomically in this order:

1. validate command identity, expected scene revision, resource limits, and referenced element IDs;
2. compute one stable history entry containing revision-free forward and inverse patches, binding inference or replacement, anchor changes, and old plus new affected bounds without mutating live state;
3. create a fresh forward dispatch against the current scene and source, then persist a new monotonic `RecoveryAttemptId` in `prepared` state containing its operation ID, history-entry ID, history epoch, sidecar base identity, expected source generation and digest, and both patches in one successful `RecoveryStore` transaction;
4. produce the next immutable canonical scene;
5. contribute exactly one isolated invertible effect to the originating editor's existing history and receive its ordered bridge acknowledgement;
6. transactionally advance that forward recovery attempt to `host-recorded-forward` with the acknowledged editor and effect identity;
7. publish the new scene revision to attached views;
8. mark the in-memory lifecycle `applied`, enqueue one coalescible save generation, and block later commands if lifecycle stabilization detects an error;
9. emit status and observability events.

Undo and Redo intents follow the same serialized validation, recovery, publication, save, and status rules with the history entry's inverse or forward patch. Each creates a fresh operation ID and expected current scene revision. Before changing the scene, it creates a new direction-specific recovery attempt in durable `host-recorded-undo` or `host-recorded-redo` state, including the history entry, acknowledged editor and effect, epoch, expected source generation and digest, expected scene revision, and direction patch. A bridge intent whose new attempt cannot reach its durable `host-recorded-*` state publishes no scene mutation, makes the already recorded host effect inert under a visible blocked status, and is never replayed automatically. The Phase 0 probe MUST demonstrate that retry, disposal, restart, repeated post-save Undo and Redo, and branch-after-Undo cannot produce revision ABA or make the host cursor and canonical scene silently disagree.

The first recovery attempt prepares the dispatch durably; the forward command becomes canonical only after the originating host history acknowledges its isolated effect and that acknowledgement is durably recorded as `host-recorded-forward`. If validation, computation, or recovery preparation fails, no canonical state, host history, DOM authority, or sidecar generation may change. If the originating editor becomes unavailable after preparation but before effect acknowledgement, the scene remains unchanged and the prepared unpublished attempt is cancelled transactionally or retained for explicit retry against that same revalidated editor identity. A crash with only `prepared` never auto-replays. If persisting a `host-recorded-*` attempt fails, the scene remains unchanged, the effect is inert and visibly blocked, and automatic replay is forbidden. After durable `host-recorded-*` acknowledgement, the remaining canonical publication steps are non-failing in-memory assignments over already validated immutable values. Recovery restores the recorded non-revision values exactly once with fresh monotonic publication revisions only when its sidecar, scene, source generation, and source digest expectations still match. A sidecar save acknowledgement removes only covered recovery attempts transactionally; it does not remove an actionable host-effect envelope or history entry.

Observed native Markdown transactions and annotation commands share one monotonic `SessionOrder` in the total `NoteSession` serialization order. `MarkdownSourceCoordinator` performs the compare-and-swap admission, duplicate-delivery recognition, actionable-history rebase, and bounded retention defined in [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md) and [Anchors and Layout](05-anchors-and-layout.md). Each admitted Markdown transaction advances one transient source generation exactly once across all panes. The active source checkpoint is relative to the last durable source generation. While that write is active, the single replaceable latest checkpoint contains only subsequent ordered changes and uses the active target generation and digest as its prior generation and digest. Replacing the waiting checkpoint composes only changes after that same active target. The resulting digest chain is contiguous and never rebases a waiting mapping against an older durable generation.

After a 100 ms idle debounce and no later than 500 ms after the first dirty source generation, the adapter computes the replacement Markdown digest and appends one revision-bound `SourceCheckpointOperation` to `RecoveryStore` before publishing that generation as canonical source state or enqueuing its sidecar save. A forced checkpoint barrier bypasses the idle debounce and immediately promotes the current latest source generation. An annotation command observed during a transient source generation schedules that barrier before acquiring its annotation-publication turn, or yields its current turn before awaiting it. The command resumes in a new turn only after acknowledgement and complete revalidation of command, binding, Markdown, layout, and scene tokens against the durable source generation. A queue turn MUST NOT await an event whose processing requires that same turn to finish. Stale checkpoint completions publish nothing and enqueue no save.

A checkpoint stores the base sidecar identity, prior and replacement Markdown digests, and the composed ordered UTF-16 offset mapping, but no duplicate Markdown text or per-element anchor array. Anchor materialization uses the immutable replacement Markdown snapshot whose digest equals the checkpoint replacement digest. It maps each affected boundary with its association and recomputes bounded context and block metadata before sidecar encoding. The checkpoint enters no host-history event. A recovery failure keeps the current view's transient mapping visible, marks source checkpoint pending, blocks annotation mutation and sidecar saves, and offers Retry while native Markdown editing remains available. Pure layout reflow creates no checkpoint.

## 10. Security and Trust Boundaries

Markdown, YAML, sidecar JSON, clipboard data, settings data, theme CSS, workspace state, and Obsidian DOM are untrusted inputs. The plugin MUST validate sidecars before allocating scene structures, constrain numeric values, reject non-finite coordinates, cap nesting and collections, and render only with safe DOM and SVG APIs.

Annotation content MUST NOT support scripts, `foreignObject`, raw HTML, external URLs, CSS injection, event attributes, or arbitrary SVG markup. Production DOM uses safe creation APIs and text content, never `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or untrusted markup parsing. No network access, telemetry, analytics, tracking, or external font is required for the product.
